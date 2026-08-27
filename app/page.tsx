'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '../lib/supabase/client';

type Tab = 'home' | 'scan' | 'people' | 'history' | 'settings';
type Toast = { title: string; detail: string } | null;

const nav: {id: Tab; label: string; icon: string}[] = [
  {id:'home',label:'HOME',icon:'⌂'},{id:'scan',label:'名刺登録',icon:'▣'},{id:'people',label:'顧客',icon:'♙'},{id:'history',label:'送信履歴',icon:'✉'},{id:'settings',label:'設定',icon:'⚙'}
];

type Customer = {id:string;name:string;initial:string;company:string;role:string;department:string;email:string;phone:string;address:string;website:string;status:string;time:string;tone:string;hasCardImage:boolean};
type ScanResult = {company:string;name:string;role:string;department:string;email:string;phone:string;address:string;website:string;rawText:string;confidence:number};
type MailTemplate = {subject:string;body:string};
type UserProfile = {company:string;name:string;role:string;department:string;email:string;phone:string;website:string;companySummary:string};
type MailProvider = 'none'|'gmail'|'workspace'|'outlook'|'microsoft365'|'smtp';
type SenderConfig = {provider:MailProvider;email:string;displayName:string;replyTo:string;smtpHost:string;smtpPort:string};
type OcrLayoutItem = {text:string;x:number;y:number;width:number;height:number;confidence:number};
type MailEvent = {id:string;to:string;name:string;company:string;subject:string;status:'送信済み'|'失敗';sentAt:string};

type OcrWorker = {recognize:(image:File)=>Promise<{data:{text:string;confidence:number}}>;terminate:()=>Promise<void>};
type TesseractBrowser = {createWorker:(languages:string,mode?:number,options?:{logger?:(message:{status:string;progress?:number})=>void;workerPath?:string;corePath?:string;langPath?:string})=>Promise<OcrWorker>};

async function getBrowserOcr(): Promise<TesseractBrowser> {
  const browserWindow=window as typeof window & {Tesseract?:TesseractBrowser;__mensionOcrLoading?:Promise<void>};
  if(browserWindow.Tesseract)return browserWindow.Tesseract;
  if(!browserWindow.__mensionOcrLoading){
    browserWindow.__mensionOcrLoading=new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='/vendor/tesseract.min.js';
      script.async=true;
      script.onload=()=>resolve();
      script.onerror=()=>reject(new Error('OCR engine could not load'));
      document.head.appendChild(script);
    });
  }
  await browserWindow.__mensionOcrLoading;
  if(!browserWindow.Tesseract)throw new Error('OCR engine is unavailable');
  return browserWindow.Tesseract;
}

async function createOcrWorker(logger?:(message:{status:string;progress?:number})=>void){
  const engine=await getBrowserOcr();
  return engine.createWorker('jpn+eng',1,{logger,workerPath:'/vendor/worker.min.js',corePath:'/vendor/core',langPath:'https://tessdata.projectnaptha.com/4.0.0'});
}

async function prepareCardImage(file:File) {
  const bitmap=await createImageBitmap(file);
  const maxSide=2600;
  const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const width=Math.max(1,Math.round(bitmap.width*scale));
  const height=Math.max(1,Math.round(bitmap.height*scale));
  const canvas=document.createElement('canvas');
  canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{alpha:false});
  if(!context)throw new Error('Image processing unavailable');
  context.filter='contrast(1.12) saturate(.9)';
  context.drawImage(bitmap,0,0,width,height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg',.9).split(',')[1];
}

async function optimizeCardImage(file:File){
  const bitmap=await createImageBitmap(file);const maxSide=1400;const scale=Math.min(1,maxSide/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('Image processing unavailable');context.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image compression failed')),'image/jpeg',.78));
}

async function recognizeCard(file:File,client:SupabaseClient|null,onProgress?:(progress:number)=>void){
  onProgress?.(8);
  if(client){
    const {data}=await client.auth.getSession();
    const token=data.session?.access_token;
    if(token){
      const image=await prepareCardImage(file);
      onProgress?.(35);
      const response=await fetch('/api/ocr',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({image})});
      if(response.ok){
        const result=await response.json();
        onProgress?.(100);
        return {text:String(result.text||''),confidence:Number(result.confidence||0),layout:Array.isArray(result.layout)?result.layout as OcrLayoutItem[]:[]};
      }
    }
  }
  const worker=await createOcrWorker(message=>{if(message.status==='recognizing text')onProgress?.(35+Math.round((message.progress||0)*65));});
  const result=await worker.recognize(file);
  await worker.terminate();
  return {...result.data,layout:[] as OcrLayoutItem[]};
}

async function loadGoogleIdentity(){
  const browserWindow=window as typeof window&{google?:any;__mensionGoogleLoading?:Promise<void>};
  if(browserWindow.google)return browserWindow.google;
  if(!browserWindow.__mensionGoogleLoading)browserWindow.__mensionGoogleLoading=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.async=true;script.onload=()=>resolve();script.onerror=()=>reject(new Error('Google connection unavailable'));document.head.appendChild(script);});
  await browserWindow.__mensionGoogleLoading;if(!browserWindow.google)throw new Error('Google connection unavailable');return browserWindow.google;
}

function gmailRawMessage(from:string,to:string,replyTo:string,subject:string,body:string){
  const headers=[`From: ${from}`,`To: ${to}`,replyTo?`Reply-To: ${replyTo}`:'',`Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,`MIME-Version: 1.0`,`Content-Type: text/plain; charset=UTF-8`,`Content-Transfer-Encoding: base64`].filter(Boolean).join('\r\n');
  const content=`${headers}\r\n\r\n${btoa(unescape(encodeURIComponent(body)))}`;
  return btoa(content).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

const emptyScan: ScanResult = {company:'',name:'',role:'',department:'',email:'',phone:'',address:'',website:'',rawText:'',confidence:0};

const titlePattern=/(代\s*表(?:取\s*締\s*役|社\s*員)?|会\s*長|社\s*長|副\s*社\s*長|専\s*務|常\s*務|取\s*締\s*役|監\s*査\s*役|執\s*行\s*役\s*員|理\s*事\s*長?|副\s*理\s*事\s*長|本\s*部\s*長|支\s*社\s*長|支\s*店\s*長|所\s*長|室\s*長|局\s*長|部\s*長|次\s*長|課\s*長|係\s*長|主\s*任|主\s*幹|主\s*査|統\s*括|責\s*任\s*者|店\s*長|工\s*場\s*長|マネージャー|リーダー|顧\s*問|相\s*談\s*役|参\s*与|創\s*業\s*者|共\s*同\s*創\s*業\s*者|院\s*長|副\s*院\s*長|医\s*師|歯\s*科\s*医\s*師|薬\s*剤\s*師|看\s*護\s*師|教\s*授|准\s*教\s*授|講\s*師|弁\s*護\s*士|司\s*法\s*書\s*士|行\s*政\s*書\s*士|税\s*理\s*士|公\s*認\s*会\s*計\s*士|社\s*会\s*保\s*険\s*労\s*務\s*士|Chief\s+[A-Za-z ]+Officer|CEO|COO|CFO|CTO|CIO|CMO|CISO|President|Vice President|Chair(?:man|person)|Representative Director|Managing Director|Executive Officer|General Manager|Manager|Director|Head|Lead|Supervisor|Partner|Founder|Owner|Principal|Consultant|Professor|Attorney)/i;

function normalized(value:string){return value.replace(/[\s・.,，。()（）-]/g,'').toLowerCase();}

function extractCard(text:string,confidence:number,layout:OcrLayoutItem[]=[]): ScanResult {
  const lines=text.split(/\r?\n/).map(v=>v.replace(/^[^\p{L}\p{N}〒+]+|[^\p{L}\p{N}@.+〒-]+$/gu,'').replace(/\s+/g,' ').trim()).filter(Boolean);
  const email=text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]??'';
  const phoneMatches=[...text.matchAll(/(?<!\d)(?:\+81[-\s]?)?0\d{1,4}[-\s]\d{1,4}[-\s]\d{3,4}(?!\d)/g)].map(match=>match[0]);
  const phone=phoneMatches.find(value=>value.replace(/\D/g,'').length>=10)??'';
  const website=text.match(/(?:https?:\/\/|www\.)[^\s]+/i)?.[0]?.replace(/[),。]+$/,'')??'';
  const company=lines.find(v=>/(株式会社|有限会社|合同会社|一般社団法人|公益社団法人|医療法人|学校法人|社会福祉法人|NPO法人|Inc\.?|LLC|Corporation|Co\.,?\s*Ltd|Limited|Company)/i.test(v))??lines.find(v=>/(サ.?ロ.?ン|事務所|オフィス|スタジオ|クリニック|医院|病院|大学|学校|協会|研究所|センター|商店|工房|企画|制作所|デザイン|サービス|ラボ|Lab\.?|Studio|Office|Consulting)/i.test(v))??'';
  const role=lines.find(v=>titlePattern.test(v))??'';
  const department=lines.find(v=>/(本部|事業部|営業部|企画部|開発部|技術部|製造部|管理部|総務部|人事部|経理部|財務部|法務部|広報部|マーケティング部|部門|支社|支店|営業所|Department|Division|Office|Team|Unit)/i.test(v)&&!titlePattern.test(v))??'';
  const excluded=new Set([company,role,department,email,phone,website]);
  const roleIndex=lines.indexOf(role);
  const expandedLines=lines.map((value,index)=>({value,index}));
  if(roleIndex>=0){
    const parts=lines.slice(roleIndex+1,roleIndex+3).map(value=>value.replace(/[^\p{Script=Han}]/gu,'')).filter(value=>value.length>=1&&value.length<=4);
    if(parts.length===2)expandedLines.push({value:`${parts[0]} ${parts[1]}`,index:roleIndex+1});
  }
  const roleLayout=layout.find(item=>normalized(item.text).includes(normalized(role))||normalized(role).includes(normalized(item.text)));
  const medianHeight=layout.length?[...layout].map(item=>item.height).sort((a,b)=>a-b)[Math.floor(layout.length/2)]||1:1;
  const nameCandidates=expandedLines.map(({value,index})=>{
    const cleaned=value.replace(/^(代\s*表\s*取\s*締\s*役|代\s*表\s*社\s*員|代\s*表|取\s*締\s*役|社\s*長|部\s*長|課\s*長|主\s*任)\s*/,'').replace(/[.,，。・]+$/,'').trim();
    const compact=cleaned.replace(/\s/g,'');
    const japaneseKanjiName=/^[\p{Script=Han}々〆ヶ\s]{2,10}$/u.test(cleaned)&&compact.length>=2&&compact.length<=8;
    const katakanaForeignName=/^[\p{Script=Katakana}ー]+(?:[\s・]+[\p{Script=Katakana}ー]+)+$/u.test(cleaned);
    const latinForeignName=/^[A-Za-zÀ-ÖØ-öø-ÿ'-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'-]+)+$/.test(cleaned);
    if(!cleaned||excluded.has(value)||/(会社|法人|サ.?ロ.?ン|シェア|ショップ|スタジオ|クリニック|医院|病院|大学|学校|協会|事務所|研究所|センター|オフィス|グループ|〒|都|道|府|県|市|区|町|村)/.test(compact)||/@|\d{3,}/.test(cleaned)||(!japaneseKanjiName&&!katakanaForeignName&&!latinForeignName))return null;
    let score=0;
    if(roleIndex>=0&&index>roleIndex&&index<=roleIndex+2)score+=12;
    if(/[\s・]/.test(cleaned))score+=5;
    if(japaneseKanjiName)score+=8;
    if(katakanaForeignName||latinForeignName)score+=5;
    if(cleaned.replace(/[\s・]/g,'').length>=3&&cleaned.replace(/[\s・]/g,'').length<=8)score+=3;
    if(index===0)score-=2;
    const item=layout.find(entry=>normalized(entry.text).includes(normalized(cleaned))||normalized(cleaned).includes(normalized(entry.text)));
    if(item){score+=Math.min(8,(item.height/medianHeight)*2);if(roleLayout){const dx=(item.x+item.width/2)-(roleLayout.x+roleLayout.width/2);const dy=(item.y+item.height/2)-(roleLayout.y+roleLayout.height/2);const distance=Math.hypot(dx,dy);const scale=Math.max(item.height,roleLayout.height,1);if(distance/scale<8)score+=8;}}
    return {value:cleaned,score,kind:japaneseKanjiName?'kanji' as const:katakanaForeignName?'katakana' as const:'latin' as const};
  }).filter((candidate):candidate is {value:string;score:number;kind:'kanji'|'katakana'|'latin'}=>candidate!==null).sort((a,b)=>b.score-a.score);
  const name=(nameCandidates.find(candidate=>candidate.kind==='kanji')??nameCandidates.find(candidate=>candidate.kind==='katakana')??nameCandidates.find(candidate=>candidate.kind==='latin'))?.value??'';
  const address=lines.find(v=>/(都|道|府|県).*(市|区|町|村)|〒\s*\d{3}-?\d{4}/.test(v))??'';
  return {company,name,role,department,email,phone,address,website,rawText:text,confidence:Math.round(confidence)};
}

export default function Home() {
  const supabase = useMemo(() => typeof window==='undefined' ? null : createClient(), []);
  const [authReady,setAuthReady] = useState(false);
  const [currentUser,setCurrentUser] = useState<string | null>(null);
  const [recovery,setRecovery] = useState(false);
  const [showGuide,setShowGuide] = useState(false);
  const [loading,setLoading] = useState(true);
  const [tab,setTab] = useState<Tab>('home');
  const [query,setQuery] = useState('');
  const [toast,setToast] = useState<Toast>(null);
  const [processing,setProcessing] = useState(false);
  const [ocrProgress,setOcrProgress] = useState(0);
  const [scanResult,setScanResult] = useState<ScanResult|null>(null);
  const [scanImage,setScanImage]=useState<Blob|null>(null);
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [showTemplate,setShowTemplate] = useState(false);
  const [showProfile,setShowProfile] = useState(false);
  const [showSender,setShowSender] = useState(false);
  const [sender,setSender] = useState<SenderConfig>({provider:'none',email:'',displayName:'',replyTo:'',smtpHost:'',smtpPort:'587'});
  const [composeCustomer,setComposeCustomer]=useState<Customer|null>(null);
  const [detailCustomer,setDetailCustomer]=useState<Customer|null>(null);
  const [selectedCustomers,setSelectedCustomers]=useState<string[]>([]);
  const [showBulkMail,setShowBulkMail]=useState(false);
  const [mailHistory,setMailHistory]=useState<MailEvent[]>([]);
  const [googleAccessToken,setGoogleAccessToken]=useState('');
  const [mailTemplate,setMailTemplate] = useState<MailTemplate>({subject:'【ご挨拶】本日はありがとうございました｜{{送信者名}}',body:'{{会社名}}\n{{氏名}} 様\n\n本日は貴重なお時間をいただき、ありがとうございました。\n{{AI生成文}}\n\n今後ともどうぞよろしくお願いいたします。'});
  const [profile,setProfile] = useState<UserProfile>({company:'',name:'',role:'',department:'',email:'',phone:'',website:'',companySummary:''});
  const [sendMode,setSendMode] = useState('confirm');
  const [autoGreeting,setAutoGreeting] = useState(true);
  const [signature,setSignature] = useState(true);
  const [companyContext,setCompanyContext] = useState(true);
  const filtered = useMemo(() => customers.filter(c => `${c.name}${c.company}${c.email}`.toLowerCase().includes(query.toLowerCase())),[customers,query]);

  useEffect(() => {
    const timer = window.setTimeout(() => setLoading(false), 2100);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    supabase.auth.getSession().then(({data}) => { setCurrentUser(data.session?.user.email ?? null); setAuthReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((event,session) => {
      setCurrentUser(session?.user.email ?? null);
      setAuthReady(true);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
    });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  useEffect(() => {
    if (!currentUser) return;
    setShowGuide(window.localStorage.getItem(`mension-guide-hidden:${currentUser}`) !== 'true');
  }, [currentUser]);

  useEffect(() => {
    if (!supabase || !currentUser) return;
    const loadData=async()=>{
      const [{data:userData},{data:contactRows},{data:settingsRows},{data:profileRow}]=await Promise.all([
        supabase.auth.getUser(),
        supabase.from('contacts').select('*'),
        supabase.from('user_settings').select('mail_subject,mail_body').maybeSingle(),
        supabase.from('user_profiles').select('*').maybeSingle(),
      ]);
      if(!userData.user) return;
      const savedSender=userData.user.user_metadata?.mension_sender as Partial<SenderConfig>|undefined;
      if(savedSender)setSender(current=>({...current,...savedSender}));
      const savedHistory=userData.user.user_metadata?.mension_mail_history;
      if(Array.isArray(savedHistory))setMailHistory(savedHistory.slice(0,50));
      if(contactRows) setCustomers(contactRows.map((row:any)=>({id:String(row.id||row.email),name:row.name||'氏名未確認',initial:(row.name||row.company||'@').slice(0,2),company:row.company||'会社名未確認',role:row.role||'',department:row.department||'',email:row.email||'',phone:row.phone||'',address:row.address||'',website:row.website||'',status:row.status==='ready'?'未送信':row.status==='needs_review'?'確認待ち':row.status||'確認待ち',time:'登録済み',tone:'gold',hasCardImage:Boolean(row.id)})).reverse());
      if(settingsRows) setMailTemplate({subject:settingsRows.mail_subject||'',body:settingsRows.mail_body||''});
      if(profileRow) setProfile({company:profileRow.company||'',name:profileRow.name||'',role:profileRow.role||'',department:profileRow.department||'',email:profileRow.email||'',phone:profileRow.phone||'',website:profileRow.website||'',companySummary:profileRow.company_summary||''});
    };
    loadData();
  },[supabase,currentUser]);

  const closeGuide = async (hideNext:boolean) => {
    if (currentUser && hideNext) window.localStorage.setItem(`mension-guide-hidden:${currentUser}`, 'true');
    if (supabase && hideNext) await supabase.auth.updateUser({data:{hide_onboarding:true}});
    setShowGuide(false);
  };

  const notify = (title:string, detail:string) => { setToast({title,detail}); window.setTimeout(()=>setToast(null),3200); };
  const upload = async (e:ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    const file=e.target.files[0];
    setProcessing(true); setOcrProgress(1); setScanResult(null);
    try{
      setScanImage(await optimizeCardImage(file));
      const result=await recognizeCard(file,supabase,setOcrProgress);
      const parsed=extractCard(result.text,result.confidence,result.layout);
      setScanResult(parsed);
      notify('名刺の解析が完了しました',parsed.email?'内容を確認して顧客へ保存してください':'メールアドレスを確認してください');
    }catch{
      notify('画像を解析できませんでした','明るい場所で名刺全体が入るように撮り直してください');
    }finally{setProcessing(false);setOcrProgress(0);e.target.value='';}
  };

  const saveContact=async()=>{
    if(!supabase||!scanResult)return;
    const {data:userData}=await supabase.auth.getUser();
    if(!userData.user){notify('保存できません','もう一度ログインしてください');return;}
    const core={user_id:userData.user.id,company:scanResult.company,name:scanResult.name,role:scanResult.role,department:scanResult.department,email:scanResult.email||null,phone:scanResult.phone,address:scanResult.address,website:scanResult.website};
    const attempts=[{...core,raw_text:scanResult.rawText,confidence:scanResult.confidence,status:scanResult.email?'ready':'needs_review'},core];
    let saveError:any=null;
    let savedId='';
    for(const payload of attempts){const {data,error}=await supabase.from('contacts').insert(payload).select('id').single();saveError=error;if(!error){savedId=String(data?.id||'');break;}if(error.code==='23505')break;}
    if(saveError?.code==='23505'){
      const {data:existing,error:readError}=await supabase.from('contacts').select('*').ilike('email',scanResult.email).maybeSingle();
      const visible=existing||{company:scanResult.company,name:scanResult.name,role:scanResult.role,email:scanResult.email,status:'ready'};
      setCustomers(prev=>[{id:String(visible.id||visible.email),name:visible.name||'氏名未確認',initial:(visible.name||visible.company||'@').slice(0,2),company:visible.company||'会社名未確認',role:visible.role||'',department:visible.department||'',email:visible.email||'',phone:visible.phone||'',address:visible.address||'',website:visible.website||'',status:visible.status==='needs_review'?'確認待ち':'未送信',time:'登録済み',tone:'gold',hasCardImage:Boolean(visible.id)},...prev.filter(customer=>customer.email.toLowerCase()!==scanResult.email.toLowerCase())]);
      setScanResult(null);setTab('people');notify('登録済みの顧客を表示しました',readError?'この端末の一覧へ復元しました':'既存の顧客データを開きました');return;
    }
    if(saveError){notify('顧客を保存できませんでした',`保存設定を確認してください（${saveError.code||'DB'}）`);return;}
    if(savedId&&scanImage){const {data}=await supabase.auth.getSession();await fetch(`/api/cards/${encodeURIComponent(savedId)}`,{method:'PUT',headers:{authorization:`Bearer ${data.session?.access_token||''}`,'content-type':'image/jpeg'},body:scanImage});}
    const savedStatus=scanResult.email?'未送信':'確認待ち';
    setCustomers(prev=>[{id:savedId||scanResult.email,name:scanResult.name||'氏名未確認',initial:(scanResult.name||scanResult.company||'@').slice(0,2),company:scanResult.company||'会社名未確認',role:scanResult.role||'',department:scanResult.department,email:scanResult.email||'',phone:scanResult.phone,address:scanResult.address,website:scanResult.website,status:savedStatus,time:'今',tone:'gold',hasCardImage:Boolean(savedId&&scanImage)},...prev]);
    setScanImage(null);
    setScanResult(null); setTab('people'); notify('顧客データへ保存しました','ユーザー専用の顧客リストへ追加しました');
  };

  const updateCustomer=async(next:Customer)=>{
    if(!supabase)return;const {error}=await supabase.from('contacts').update({company:next.company,name:next.name,role:next.role,department:next.department,email:next.email||null,phone:next.phone,address:next.address,website:next.website}).eq('id',next.id);
    if(error){notify('更新できませんでした','入力内容を確認してください');return;}
    setCustomers(current=>current.map(customer=>customer.id===next.id?{...next,initial:(next.name||next.company||'@').slice(0,2)}:customer));setDetailCustomer(null);notify('顧客情報を更新しました','名刺の記載情報を保存しました');
  };

  const saveTemplate=async(template:MailTemplate)=>{
    if(!supabase)return;
    const {data:userData}=await supabase.auth.getUser();
    if(!userData.user)return;
    const {error}=await supabase.from('user_settings').upsert({user_id:userData.user.id,mail_subject:template.subject,mail_body:template.body,updated_at:new Date().toISOString()});
    if(error){notify('テンプレートを保存できませんでした','もう一度お試しください');return;}
    setMailTemplate(template);setShowTemplate(false);notify('メールテンプレートを保存しました','次回の文面生成から反映されます');
  };

  const saveProfile=async(next:UserProfile)=>{
    if(!supabase)return;
    const {data:userData}=await supabase.auth.getUser();
    if(!userData.user)return;
    const {error}=await supabase.from('user_profiles').upsert({user_id:userData.user.id,company:next.company,name:next.name,role:next.role,department:next.department,email:next.email,phone:next.phone,website:next.website,company_summary:next.companySummary,updated_at:new Date().toISOString()});
    if(error){notify('プロフィールを保存できませんでした','入力内容を確認してください');return;}
    setProfile(next);setShowProfile(false);notify('使用者プロフィールを保存しました','署名とAI文面生成に利用できます');
  };

  const saveSender=async(next:SenderConfig)=>{
    if(!supabase)return;
    const {error}=await supabase.auth.updateUser({data:{mension_sender:next}});
    if(error){notify('送信元を保存できませんでした','もう一度お試しください');return;}
    setSender(next);setShowSender(false);notify('送信元メールを切り替えました',`${providerLabel(next.provider)} · ${next.email}`);
  };

  const connectGoogle=async()=>{
    let clientId='';
    try{const config=await fetch('/api/google-config',{cache:'no-store'}).then(response=>response.json());clientId=String(config.clientId||'');}catch{}
    if(!clientId){notify('Google接続の準備中です','OAuthクライアントIDを設定すると接続できます');return;}
    try{const google=await loadGoogleIdentity();google.accounts.oauth2.initTokenClient({client_id:clientId,scope:'https://www.googleapis.com/auth/gmail.send',callback:(response:any)=>{if(response.access_token){setGoogleAccessToken(response.access_token);notify('Googleメールを接続しました','このブラウザで安全に送信できます');}else notify('Google接続を完了できませんでした','もう一度お試しください');}}).requestAccessToken({prompt:'consent'});}catch{notify('Google接続を開始できませんでした','通信状態を確認してください');}
  };

  const sendMailTo=async(customer:Customer,subject:string,body:string)=>{
    if(!googleAccessToken||!['gmail','workspace'].includes(sender.provider))throw new Error('not connected');
    const response=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{authorization:`Bearer ${googleAccessToken}`,'content-type':'application/json'},body:JSON.stringify({raw:gmailRawMessage(`${sender.displayName} <${sender.email}>`,customer.email,sender.replyTo,subject,body)})});
    if(!response.ok)throw new Error('send failed');
    return {id:crypto.randomUUID(),to:customer.email,name:customer.name,company:customer.company,subject,status:'送信済み' as const,sentAt:new Date().toISOString()};
  };

  const sendMail=async(subject:string,body:string)=>{
    if(!composeCustomer)throw new Error('customer missing');
    const event=await sendMailTo(composeCustomer,subject,body);
    const next=[event,...mailHistory].slice(0,50);setMailHistory(next);setComposeCustomer(null);
    if(supabase)await supabase.auth.updateUser({data:{mension_mail_history:next}});
    notify('メールを送信しました',`${event.name} 様への送信が完了しました`);
  };

  const sendBulkMail=async()=>{
    const targets=customers.filter(customer=>selectedCustomers.includes(customer.email)&&customer.email);
    if(!targets.length)throw new Error('targets missing');
    const replace=(value:string,customer:Customer)=>value.replaceAll('{{会社名}}',customer.company).replaceAll('{{氏名}}',customer.name).replaceAll('{{役職}}',customer.role).replaceAll('{{送信者名}}',sender.displayName).replaceAll('{{AI生成文}}',`${customer.company||'貴社'}でのお取り組みについて、ぜひ改めてお話を伺えれば幸いです。`);
    const events:MailEvent[]=[];
    for(const customer of targets)events.push(await sendMailTo(customer,replace(mailTemplate.subject,customer),replace(mailTemplate.body,customer)));
    const next=[...events,...mailHistory].slice(0,50);setMailHistory(next);setSelectedCustomers([]);setShowBulkMail(false);
    if(supabase)await supabase.auth.updateUser({data:{mension_mail_history:next}});
    notify('まとめて送信しました',`${events.length}件の送信が完了しました`);
  };

  return <main className={`app-shell ${loading?'is-loading':'is-ready'}`}>
    {loading&&<div className="splash" role="status" aria-label="MENSIONを起動しています">
      <div className="splash-glow"/>
      <div className="splash-logo"><span>@</span></div>
      <div className="splash-name">MENSION</div>
      <div className="splash-copy">CONTACTS INTO OPPORTUNITIES</div>
      <div className="splash-progress"><i/></div>
      <small>POWERED BY AI</small>
    </div>}
    {authReady&&!currentUser&&<AuthScreen client={supabase} recovery={recovery} onAuthenticated={setCurrentUser} onRecoveryDone={()=>setRecovery(false)}/>} 
    <header className="topbar">
      <button className="wordmark" onClick={()=>setTab('home')} aria-label="MENSION ホームへ"><span>@</span><div><b>MENSION</b><small>メンション</small></div></button>
      <div className="top-actions"><button className="notification" aria-label="通知">●</button><button className="avatar" aria-label="アカウント">YT</button></div>
    </header>

    {tab==='home' && <HomeView go={setTab} notify={notify} customers={customers} />}
    {tab==='scan' && <ScanView processing={processing} progress={ocrProgress} upload={upload} notify={notify} result={scanResult} setResult={setScanResult} save={saveContact} />}
    {tab==='people' && <PeopleView query={query} setQuery={setQuery} customers={filtered} notify={notify} onCompose={setComposeCustomer} onDetail={setDetailCustomer} selected={selectedCustomers} setSelected={setSelectedCustomers} onBulk={()=>setShowBulkMail(true)} />}
    {tab==='history' && <HistoryView history={mailHistory} notify={notify} />}
    {tab==='settings' && <SettingsView sender={sender} googleConnected={!!googleAccessToken} sendMode={sendMode} setSendMode={setSendMode} autoGreeting={autoGreeting} setAutoGreeting={setAutoGreeting} signature={signature} setSignature={setSignature} companyContext={companyContext} setCompanyContext={setCompanyContext} notify={notify} onOpenGuide={()=>setShowGuide(true)} onOpenTemplate={()=>setShowTemplate(true)} onOpenProfile={()=>setShowProfile(true)} onOpenSender={()=>setShowSender(true)} />}

    <nav className="bottom-nav" aria-label="メインメニュー">{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>
    {currentUser&&showGuide&&<OnboardingGuide onClose={closeGuide}/>} 
    {showTemplate&&<TemplateEditor value={mailTemplate} onClose={()=>setShowTemplate(false)} onSave={saveTemplate}/>} 
    {showProfile&&<ProfileEditor value={profile} client={supabase} onClose={()=>setShowProfile(false)} onSave={saveProfile}/>} 
    {showSender&&<SenderEditor value={sender} googleConnected={!!googleAccessToken} onConnectGoogle={connectGoogle} onClose={()=>setShowSender(false)} onSave={saveSender}/>} 
    {composeCustomer&&<MailComposer customer={composeCustomer} template={mailTemplate} sender={sender} connected={!!googleAccessToken} onConnect={connectGoogle} onClose={()=>setComposeCustomer(null)} onSend={sendMail}/>} 
    {detailCustomer&&<CustomerDetail customer={detailCustomer} client={supabase} onClose={()=>setDetailCustomer(null)} onSave={updateCustomer} onCompose={()=>{setComposeCustomer(detailCustomer);setDetailCustomer(null);}}/>}
    {showBulkMail&&<BulkMailConfirm count={selectedCustomers.length} sender={sender} connected={!!googleAccessToken} onConnect={connectGoogle} onClose={()=>setShowBulkMail(false)} onSend={sendBulkMail}/>} 
    {toast&&<div className="toast" role="status"><span>✓</span><div><strong>{toast.title}</strong><small>{toast.detail}</small></div></div>}
  </main>;
}

function PageHead({kicker,title,sub}:{kicker:string;title:string;sub?:string}) { return <div className="page-head"><p>{kicker}</p><h1>{title}</h1>{sub&&<span>{sub}</span>}</div>; }

function HomeView({go,notify,customers}:{go:(t:Tab)=>void;notify:(a:string,b:string)=>void;customers:Customer[]}) {
  return <section className="screen home-screen">
    <div className="home-intro"><div><p>MENSION AI</p><h1>名刺から、<br/><em>次の商談をつくる。</em></h1><span>撮影するだけで顧客登録とフォロー文面を準備します</span></div><button className="home-profile" aria-label="アカウント">YT</button></div>
    <article className="capture-card"><div className="capture-aura"/><button className="scan-orb" onClick={()=>go('scan')} aria-label="名刺をスキャン"><span className="scan-mark">▣</span><strong>SCAN</strong><small>名刺を撮影</small></button><div className="capture-copy"><span><i/>AI READY</span><strong>名刺を枠に合わせて撮影</strong><small>会社・氏名・連絡先を自動で読み取ります</small></div></article>
    <div className="quick-actions"><button onClick={()=>go('scan')}><span>＋</span><div><strong>画像から登録</strong><small>複数枚も一括で</small></div><b>›</b></button><button onClick={()=>go('people')}><span>♙</span><div><strong>顧客を確認</strong><small>登録済みの連絡先</small></div><b>›</b></button></div>
    <div className="summary-head"><div><small>TODAY</small><h3>今日の進捗</h3></div><span>8月27日</span></div>
    <div className="kpi-grid"><article><small>登録名刺</small><strong>0<em>件</em></strong><span>名刺登録で開始</span></article><article><small>送信完了</small><strong>0<em>件</em></strong><span>送信履歴なし</span></article><article className="attention" onClick={()=>go('scan')}><small>要確認</small><strong>0<em>件</em></strong><span>名刺を登録 →</span></article></div>
    <div className="section-row"><div><small>LATEST ACTIVITY</small><h3>最近のアクティビティ</h3></div><button onClick={()=>go('history')}>すべて見る</button></div>
    <div className="activity-list">{customers.length===0?<div className="empty-state"><span>@</span><strong>最初の名刺を登録しましょう</strong><small>登録すると、ここに最近の活動が表示されます</small><button onClick={()=>go('scan')}>名刺を登録する</button></div>:customers.slice(0,3).map(c=><button key={c.email} onClick={()=>notify(c.name,`${c.company}・${c.email}`)}><span className={`initial ${c.tone}`}>{c.initial}</span><span className="contact"><strong>{c.name}</strong><small>{c.company} ・ {c.role}</small></span><span className={`status ${c.status==='確認待ち'?'pending':'sent'}`}>{c.status}</span><time>{c.time}</time></button>)}</div>
  </section>;
}

function ScanView({processing,progress,upload,notify,result,setResult,save}:{processing:boolean;progress:number;upload:(e:ChangeEvent<HTMLInputElement>)=>void;notify:(a:string,b:string)=>void;result:ScanResult|null;setResult:(r:ScanResult|null)=>void;save:()=>void}) {
  return <section className="screen"><PageHead kicker="SCAN BUSINESS CARD" title="名刺を登録" sub="AIが最短3秒でデータ化します"/>
    <label className={`scan-stage ${processing?'processing':''}`}><input type="file" accept="image/*" capture="environment" multiple onChange={upload}/><div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/><div className="scan-icon">{processing?'◌':'▣'}</div><h2>{processing?`OCR解析中 ${progress}%`:'カメラで名刺を撮影'}</h2><p>{processing?'日本語・英語の文字と連絡先を読み取っています':'枠内に名刺を合わせてタップしてください'}</p><span>{processing?'READING':'カメラを起動'}</span></label>
    <div className="or"><i/>OR<i/></div><label className="upload-row"><input type="file" accept="image/*" multiple onChange={upload}/><span>＋</span><div><strong>画像をアップロード</strong><small>複数枚をまとめて選択できます</small></div><b>→</b></label>
    <div className="scan-note"><span>AI</span><p><strong>読み取り後も安心</strong>信頼度が低い項目や重複候補は自動送信せず、確認待ちに振り分けます。</p></div>
    <button className="sample-action" onClick={()=>notify('サンプル解析を開始しました','名刺情報を安全に確認待ちへ追加します')}>サンプル名刺で試す</button>
    {result&&<div className="scan-result"><div className="scan-result-head"><div><small>OCR RESULT · 信頼度 {result.confidence}%</small><h3>読み取り結果を確認</h3></div><button onClick={()=>setResult(null)}>×</button></div><div className="result-fields">{([['会社名','company'],['氏名','name'],['部署','department'],['役職','role'],['メール','email'],['電話番号','phone'],['住所','address'],['Webサイト','website']] as const).map(([label,key])=><label key={key}><span>{label}</span><input value={result[key]} onChange={e=>setResult({...result,[key]:e.target.value})} placeholder={`${label}を入力`}/></label>)}</div><button className="save-contact" onClick={save}>顧客データとして保存</button><small className="result-note">保存前に内容を確認してください。低信頼またはメール未検出時は確認待ちになります。</small></div>}
  </section>;
}

function PeopleView({query,setQuery,customers,notify,onCompose,onDetail,selected,setSelected,onBulk}:{query:string;setQuery:(v:string)=>void;customers:Customer[];notify:(a:string,b:string)=>void;onCompose:(customer:Customer)=>void;onDetail:(customer:Customer)=>void;selected:string[];setSelected:(value:string[])=>void;onBulk:()=>void}) {
  const toggle=(email:string)=>setSelected(selected.includes(email)?selected.filter(value=>value!==email):[...selected,email]);
  return <section className="screen"><PageHead kicker="CONTACTS" title="顧客リスト" sub={`${customers.length}件のコンタクト`}/><div className="search"><span>⌕</span><input aria-label="顧客を検索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="氏名・会社名・メールで検索"/><button onClick={()=>notify('フィルター','登録日・送信状態・担当者で絞り込めます')}>絞込</button></div><div className="filter-chips"><button className="selected">すべて</button><button>確認待ち 0</button><button>送信済み</button><button>未送信</button></div>
    {customers.length>0&&<div className="bulk-toolbar"><button onClick={()=>setSelected(selected.length===customers.filter(c=>c.email).length?[]:customers.filter(c=>c.email).map(c=>c.email))}>{selected.length?'選択解除':'すべて選択'}</button><span>{selected.length}件選択中</span><button className="bulk-send" disabled={!selected.length} onClick={onBulk}>まとめてメール</button></div>}
    <div className="people-list selectable">{customers.length===0?<div className="empty-state compact-empty"><span>♙</span><strong>顧客はまだ登録されていません</strong><small>名刺を読み取ると自動で顧客リストに追加されます</small></div>:customers.map(c=><article key={c.id} className={selected.includes(c.email)?'is-selected':''}><button className="contact-check" disabled={!c.email} onClick={()=>toggle(c.email)} aria-label={`${c.name}を選択`}>{selected.includes(c.email)?'✓':''}</button><span className={`initial ${c.tone}`} onClick={()=>onDetail(c)}>{c.initial}</span><div onClick={()=>onDetail(c)}><strong>{c.name}<i className={`dot ${c.status==='確認待ち'?'amber':''}`}/></strong><small>{c.company} ・ {c.role}</small><a>{c.email}</a></div><button onClick={()=>onCompose(c)} aria-label={`${c.name}へメールを作成`}>✉</button></article>)}</div>
    <button className="export-btn" onClick={()=>notify('CSVを書き出しました','顧客データを安全にエクスポートしました')}>↓　CSVエクスポート</button>
  </section>;
}

function CustomerDetail({customer,client,onClose,onSave,onCompose}:{customer:Customer;client:SupabaseClient|null;onClose:()=>void;onSave:(customer:Customer)=>Promise<void>;onCompose:()=>void}){
  const [draft,setDraft]=useState(customer);const [editing,setEditing]=useState(false);const [imageUrl,setImageUrl]=useState('');const [imageLoading,setImageLoading]=useState(customer.hasCardImage);const [saving,setSaving]=useState(false);
  useEffect(()=>{let objectUrl='';if(!customer.hasCardImage||!client){setImageLoading(false);return;}client.auth.getSession().then(async({data})=>{const response=await fetch(`/api/cards/${encodeURIComponent(customer.id)}`,{headers:{authorization:`Bearer ${data.session?.access_token||''}`}});if(response.ok){objectUrl=URL.createObjectURL(await response.blob());setImageUrl(objectUrl);}setImageLoading(false);});return()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);};},[customer.id,customer.hasCardImage,client]);
  const save=async()=>{setSaving(true);await onSave(draft);setSaving(false);};
  const fields:Array<[string,keyof Customer]>=[['会社名','company'],['氏名','name'],['部署','department'],['役職・肩書','role'],['メール','email'],['電話番号','phone'],['住所','address'],['Webサイト','website']];
  return <div className="template-overlay detail-overlay" role="dialog" aria-modal="true"><div className="template-card customer-detail"><div className="template-head"><div><small>CONTACT CARD</small><h2>顧客詳細</h2></div><button onClick={onClose}>×</button></div><div className="card-photo" aria-busy={imageLoading}>{imageLoading?<div className="image-skeleton">名刺画像を読み込み中…</div>:imageUrl?<img src={imageUrl} alt={`${customer.name}の名刺`} loading="lazy" decoding="async"/>:<div className="image-empty"><span>@</span><small>名刺画像は未保存です</small></div>}</div><div className="detail-heading"><div><strong>{draft.name}</strong><small>{draft.company}</small></div><button onClick={()=>setEditing(value=>!value)}>{editing?'表示に戻る':'編集する'}</button></div><div className="detail-fields">{fields.map(([label,key])=><label key={key}><span>{label}</span>{editing?<input type={key==='email'?'email':'text'} value={String(draft[key]||'')} onChange={event=>setDraft({...draft,[key]:event.target.value})}/>:key==='website'&&draft.website?<a href={draft.website.startsWith('http')?draft.website:`https://${draft.website}`} target="_blank" rel="noreferrer">{draft.website}</a>:<strong>{String(draft[key]||'—')}</strong>}</label>)}</div><div className="template-actions"><button onClick={onCompose}>メールを作成</button>{editing?<button onClick={save} disabled={saving}>{saving?'保存中…':'変更を保存'}</button>:<button onClick={onClose}>閉じる</button>}</div></div></div>;
}

function BulkMailConfirm({count,sender,connected,onConnect,onClose,onSend}:{count:number;sender:SenderConfig;connected:boolean;onConnect:()=>void;onClose:()=>void;onSend:()=>Promise<void>}){
  const [sending,setSending]=useState(false);const [error,setError]=useState('');
  const submit=async()=>{setSending(true);setError('');try{await onSend();}catch{setError('送信を完了できませんでした。接続状態を確認して、もう一度お試しください。');setSending(false);}};
  return <div className="template-overlay" role="dialog" aria-modal="true"><div className="template-card bulk-confirm"><div className="template-head"><div><small>BULK SEND</small><h2>まとめて送信</h2></div><button onClick={onClose}>×</button></div><div className="bulk-count"><strong>{count}</strong><span>件へ個別送信</span></div><p>テンプレートの会社名・氏名・役職を顧客ごとに差し替えて、1通ずつ送信します。宛先同士にメールアドレスは表示されません。</p><div className="sender-security"><span>✉</span><small>送信元：{sender.email||'未設定'}（{providerLabel(sender.provider)}）</small></div>{error&&<div className="profile-message">{error}</div>}{!connected&&<button className="connect-before-send" onClick={onConnect}>Googleメールを接続して送信を有効化</button>}<div className="template-actions"><button onClick={onClose}>キャンセル</button><button disabled={!connected||sending} onClick={submit}>{sending?'送信中…':`${count}件を送信`}</button></div></div></div>;
}

function HistoryView({history,notify}:{history:MailEvent[];notify:(a:string,b:string)=>void}) { const success=history.filter(item=>item.status==='送信済み').length;return <section className="screen"><PageHead kicker="MAIL ACTIVITY" title="送信履歴" sub={`${history.length}件の送信記録`}/><div className="mail-overview"><div><small>THIS MONTH</small><strong>{history.length}<em>通</em></strong><span>送信結果を安全に記録</span></div><div className="ring"><b>{history.length?Math.round(success/history.length*100):'—'}{history.length?'%':''}</b><small>SUCCESS</small></div></div><div className="timeline"><h3>履歴</h3>{history.length===0?<div className="empty-state compact-empty"><span>✉</span><strong>メールはまだ送信されていません</strong><small>顧客を選択して文面を作成できます</small></div>:history.map(item=><button className="mail-event" key={item.id} onClick={()=>notify(item.name,item.subject)}><span>✉</span><div><strong>{item.name} 様</strong><small>{item.company} · {item.subject}</small></div><time>{new Date(item.sentAt).toLocaleString('ja-JP')}</time></button>)}</div></section>; }

function providerLabel(provider:MailProvider){return ({none:'未設定',gmail:'Gmail',workspace:'Google Workspace',outlook:'Outlook.com',microsoft365:'Microsoft 365',smtp:'独自ドメイン / SMTP'})[provider];}

function SettingsView({sender,googleConnected,sendMode,setSendMode,autoGreeting,setAutoGreeting,signature,setSignature,companyContext,setCompanyContext,notify,onOpenGuide,onOpenTemplate,onOpenProfile,onOpenSender}:{sender:SenderConfig;googleConnected:boolean;sendMode:string;setSendMode:(v:string)=>void;autoGreeting:boolean;setAutoGreeting:(v:boolean)=>void;signature:boolean;setSignature:(v:boolean)=>void;companyContext:boolean;setCompanyContext:(v:boolean)=>void;notify:(a:string,b:string)=>void;onOpenGuide:()=>void;onOpenTemplate:()=>void;onOpenProfile:()=>void;onOpenSender:()=>void}) { return <section className="screen settings"><PageHead kicker="PREFERENCES" title="設定" sub="あなたらしいフォローを自動化"/>
    <button className="guide-setting" onClick={onOpenGuide}><span>?</span><div><strong>MENSIONの使い方</strong><small>名刺登録からメール送信までを確認</small></div><b>見る</b></button>
    <div className="settings-group"><h3>送信モード</h3><p>名刺読み取り後の動作を選択</p><div className="mode-select">{[['auto','完全自動','読み取り後すぐ送信'],['confirm','確認して送信','内容を確認してから'],['off','送信なし','リスト登録のみ']].map(m=><button key={m[0]} onClick={()=>setSendMode(m[0])} className={sendMode===m[0]?'selected':''}><i>{sendMode===m[0]?'●':'○'}</i><span><strong>{m[1]}</strong><small>{m[2]}</small></span></button>)}</div></div>
    <button className="setting-row" onClick={onOpenSender}><span className="setting-icon">@</span><div><strong>送信元メール</strong><small>{sender.email||'メールサービスを選択してください'} · {providerLabel(sender.provider)}</small></div><em className={googleConnected?'connected':'pending-mail'}>{googleConnected?'接続中':sender.provider==='none'?'未設定':'要接続'}</em><b>›</b></button>
    <button className="setting-row" onClick={onOpenTemplate}><span className="setting-icon">T</span><div><strong>メールテンプレート</strong><small>件名・本文・差し込み変数を編集</small></div><b>›</b></button>
    <button className="profile-setting" onClick={onOpenProfile}><span className="setting-icon">ME</span><div><strong>使用者プロフィール</strong><small>自分の名刺・会社サイトから簡単登録</small></div><b>›</b></button>
    <div className="settings-group compact"><h3>AI生成設定</h3><Toggle label="相手企業に合わせて文面を最適化" value={companyContext} set={setCompanyContext}/><Toggle label="宛名・冒頭挨拶を自動生成" value={autoGreeting} set={setAutoGreeting}/><Toggle label="署名を自動で追加" value={signature} set={setSignature}/><button className="ai-range" onClick={()=>notify('企業別AI生成','業種・事業内容・役職・面談メモを文面へ反映します')}><span>AI</span><div><strong>企業情報の反映範囲</strong><small>業種・事業内容・役職・面談メモ</small></div><b>›</b></button></div>
    <div className="security-note"><span>♢</span><div><strong>セキュリティ保護中</strong><small>認証情報の暗号化・ユーザー別データ分離・操作履歴を有効化</small></div></div>
    <button className="admin-link" onClick={()=>notify('管理者画面','ユーザー・送信量・監査ログを管理できます')}>管理者メニュー <span>›</span></button>
  </section>; }

function Toggle({label,value,set}:{label:string;value:boolean;set:(v:boolean)=>void}) { return <button className="toggle-row" onClick={()=>set(!value)}><span>{label}</span><i className={value?'on':''}><b/></i></button>; }

function TemplateEditor({value,onClose,onSave}:{value:MailTemplate;onClose:()=>void;onSave:(v:MailTemplate)=>void}) {
  const [draft,setDraft]=useState(value);
  const insert=(token:string)=>setDraft(v=>({...v,body:`${v.body}${v.body.endsWith('\n')?'':'\n'}${token}`}));
  return <div className="template-overlay" role="dialog" aria-modal="true" aria-labelledby="template-title"><div className="template-card"><div className="template-head"><div><small>MAIL TEMPLATE</small><h2 id="template-title">メール文面を編集</h2></div><button onClick={onClose} aria-label="閉じる">×</button></div><label><span>件名</span><input value={draft.subject} onChange={e=>setDraft({...draft,subject:e.target.value})}/></label><label><span>本文</span><textarea rows={12} value={draft.body} onChange={e=>setDraft({...draft,body:e.target.value})}/></label><div className="template-vars"><small>差し込み変数</small><div>{['{{会社名}}','{{氏名}}','{{役職}}','{{AI生成文}}','{{送信者名}}'].map(v=><button key={v} onClick={()=>insert(v)}>{v}</button>)}</div></div><div className="template-actions"><button onClick={onClose}>キャンセル</button><button onClick={()=>onSave(draft)} disabled={!draft.subject.trim()||!draft.body.trim()}>この内容を保存</button></div></div></div>;
}

function SenderEditor({value,googleConnected,onConnectGoogle,onClose,onSave}:{value:SenderConfig;googleConnected:boolean;onConnectGoogle:()=>void;onClose:()=>void;onSave:(v:SenderConfig)=>void}){
  const [draft,setDraft]=useState(value);
  const providers:Array<[MailProvider,string,string]>=[['gmail','G','Gmail'],['workspace','GW','Google Workspace'],['outlook','O','Outlook.com'],['microsoft365','M365','Microsoft 365'],['smtp','SMTP','独自ドメイン / SMTP']];
  return <div className="template-overlay" role="dialog" aria-modal="true" aria-labelledby="sender-title"><div className="template-card sender-card"><div className="template-head"><div><small>MAIL CONNECTION</small><h2 id="sender-title">送信元メールを選択</h2></div><button onClick={onClose} aria-label="閉じる">×</button></div><p className="sender-lead">利用するメールサービスをいつでも切り替えられます。</p><div className="provider-grid">{providers.map(([id,mark,label])=><button key={id} className={draft.provider===id?'selected':''} onClick={()=>setDraft({...draft,provider:id})}><i>{mark}</i><span>{label}</span><b>{draft.provider===id?'✓':'›'}</b></button>)}</div><div className="sender-fields"><label><span>送信者名</span><input value={draft.displayName} onChange={e=>setDraft({...draft,displayName:e.target.value})} placeholder="山田 太郎"/></label><label><span>送信元メールアドレス</span><input type="email" value={draft.email} onChange={e=>setDraft({...draft,email:e.target.value})} placeholder="you@company.jp"/></label><label><span>返信先メールアドレス（任意）</span><input type="email" value={draft.replyTo} onChange={e=>setDraft({...draft,replyTo:e.target.value})} placeholder="reply@company.jp"/></label>{draft.provider==='smtp'&&<div className="smtp-fields"><label><span>SMTPサーバー</span><input value={draft.smtpHost} onChange={e=>setDraft({...draft,smtpHost:e.target.value})} placeholder="smtp.example.jp"/></label><label><span>ポート</span><input inputMode="numeric" value={draft.smtpPort} onChange={e=>setDraft({...draft,smtpPort:e.target.value})} placeholder="587"/></label></div>}</div>{['gmail','workspace'].includes(draft.provider)&&<button className={`google-connect ${googleConnected?'connected':''}`} onClick={onConnectGoogle}><span>G</span><div><strong>{googleConnected?'Googleメール接続済み':'Googleアカウントと接続'}</strong><small>送信権限だけを安全に許可</small></div><b>{googleConnected?'✓':'接続'}</b></button>}<div className="sender-security"><span>♢</span><small>アクセストークンはメモリ内だけで使用し、ページを閉じると破棄します。</small></div><div className="template-actions"><button onClick={onClose}>キャンセル</button><button onClick={()=>onSave(draft)} disabled={draft.provider==='none'||!draft.email.includes('@')||!draft.displayName.trim()}>送信元として保存</button></div></div></div>;
}

function MailComposer({customer,template,sender,connected,onConnect,onClose,onSend}:{customer:Customer;template:MailTemplate;sender:SenderConfig;connected:boolean;onConnect:()=>void;onClose:()=>void;onSend:(subject:string,body:string)=>Promise<void>}){
  const replace=(value:string)=>value.replaceAll('{{会社名}}',customer.company).replaceAll('{{氏名}}',customer.name).replaceAll('{{役職}}',customer.role).replaceAll('{{送信者名}}',sender.displayName).replaceAll('{{AI生成文}}',`${customer.company||'貴社'}でのお取り組みについて、ぜひ改めてお話を伺えれば幸いです。`);
  const [subject,setSubject]=useState(replace(template.subject));const [body,setBody]=useState(replace(template.body));const [sending,setSending]=useState(false);const [error,setError]=useState('');
  const submit=async()=>{setSending(true);setError('');try{await onSend(subject,body);}catch{setError('送信できませんでした。Googleメールを接続し直してください。');setSending(false);}};
  return <div className="template-overlay" role="dialog" aria-modal="true" aria-labelledby="composer-title"><div className="template-card composer-card"><div className="template-head"><div><small>NEW MESSAGE</small><h2 id="composer-title">フォローメールを送信</h2></div><button onClick={onClose}>×</button></div><div className="mail-to"><span>TO</span><div><strong>{customer.name} 様</strong><small>{customer.email} · {customer.company}</small></div></div><label><span>件名</span><input value={subject} onChange={e=>setSubject(e.target.value)}/></label><label><span>本文</span><textarea rows={12} value={body} onChange={e=>setBody(e.target.value)}/></label>{error&&<div className="profile-message">{error}</div>}{!connected&&<button className="connect-before-send" onClick={onConnect}>Googleメールを接続して送信を有効化</button>}<div className="template-actions"><button onClick={onClose}>下書きを閉じる</button><button onClick={submit} disabled={!connected||sending||!subject.trim()||!body.trim()}>{sending?'送信中…':'この内容で送信'}</button></div></div></div>;
}

function ProfileEditor({value,client,onClose,onSave}:{value:UserProfile;client:SupabaseClient|null;onClose:()=>void;onSave:(v:UserProfile)=>void}) {
  const [draft,setDraft]=useState(value);const [reading,setReading]=useState(false);const [summarizing,setSummarizing]=useState(false);const [message,setMessage]=useState('');
  const readCard=async(e:ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0];if(!file)return;setReading(true);setMessage('名刺を読み取っています…');try{const result=await recognizeCard(file,client);const card=extractCard(result.text,result.confidence,result.layout);setDraft(v=>({...v,company:card.company,name:card.name,role:card.role,department:card.department,email:card.email,phone:card.phone,website:card.website||v.website}));setMessage('名刺の内容を入力しました。確認して保存してください。');}catch{setMessage('読み取れませんでした。明るい場所で撮り直してください。');}finally{setReading(false);e.target.value='';}};
  const summarize=async()=>{if(!draft.website.trim())return;setSummarizing(true);setMessage('会社サイトを確認しています…');try{const res=await fetch(`/api/site-summary?url=${encodeURIComponent(draft.website)}`);const data=await res.json();if(!res.ok)throw new Error();setDraft(v=>({...v,companySummary:data.summary||''}));setMessage('サイト情報から会社概要の下書きを作成しました。');}catch{setMessage('サイトを読み取れませんでした。URLを確認してください。');}finally{setSummarizing(false);}};
  return <div className="template-overlay" role="dialog" aria-modal="true" aria-labelledby="profile-title"><div className="template-card profile-card"><div className="template-head"><div><small>MY PROFILE</small><h2 id="profile-title">使用者情報を登録</h2></div><button onClick={onClose}>×</button></div><label className="profile-scan"><input type="file" accept="image/*" capture="environment" onChange={readCard}/><span>▣</span><div><strong>{reading?'名刺を解析中…':'自分の名刺を撮影・選択'}</strong><small>会社名・氏名・役職・連絡先を自動入力</small></div><b>›</b></label>{message&&<div className="profile-message">{message}</div>}<div className="result-fields profile-fields">{([['会社名','company'],['氏名','name'],['部署','department'],['役職','role'],['メール','email'],['電話番号','phone']] as const).map(([label,key])=><label key={key}><span>{label}</span><input value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}</div><div className="website-box"><label><span>会社Webサイト</span><div><input value={draft.website} onChange={e=>setDraft({...draft,website:e.target.value})} placeholder="https://example.jp"/><button onClick={summarize} disabled={summarizing||!draft.website.trim()}>{summarizing?'読取中…':'サイトを要約'}</button></div></label><label><span>会社・事業概要</span><textarea rows={6} value={draft.companySummary} onChange={e=>setDraft({...draft,companySummary:e.target.value})} placeholder="Webサイトから自動作成、または手入力できます"/></label></div><div className="template-actions"><button onClick={onClose}>キャンセル</button><button onClick={()=>onSave(draft)} disabled={!draft.name.trim()||!draft.company.trim()}>プロフィールを保存</button></div></div></div>;
}

function OnboardingGuide({onClose}:{onClose:(hideNext:boolean)=>void}) {
  const [hideNext,setHideNext] = useState(false);
  return <div className="guide-overlay" role="dialog" aria-modal="true" aria-labelledby="guide-title"><div className="guide-card"><div className="guide-brand"><span>@</span><small>QUICK START</small></div><h2 id="guide-title">MENSIONへようこそ</h2><p>名刺を撮るだけで、次のアクションまでつながります。</p><div className="guide-steps"><article><i>01</i><span>▣</span><div><strong>名刺を登録</strong><small>撮影、または複数画像をまとめて選択します。</small></div></article><article><i>02</i><span>AI</span><div><strong>AIが内容を確認</strong><small>顧客情報を抽出し、曖昧な項目だけ確認待ちにします。</small></div></article><article><i>03</i><span>✉</span><div><strong>相手に合わせて送信</strong><small>企業情報や役職を反映した文面を確認して送ります。</small></div></article></div><label className="guide-check"><input type="checkbox" checked={hideNext} onChange={e=>setHideNext(e.target.checked)}/><span>次回からこの説明を表示しない</span></label><button className="guide-start" onClick={()=>onClose(hideNext)}>MENSIONをはじめる</button><small className="guide-foot">このガイドは設定からいつでも確認できます</small></div></div>;
}

function AuthScreen({client,recovery,onAuthenticated,onRecoveryDone}:{client:SupabaseClient|null;recovery:boolean;onAuthenticated:(email:string)=>void;onRecoveryDone:()=>void}) {
  const [mode,setMode] = useState<'login'|'signup'|'reset'|'update'>(recovery?'update':'login');
  const [email,setEmail] = useState(''); const [password,setPassword] = useState(''); const [confirm,setConfirm] = useState('');
  const [busy,setBusy] = useState(false); const [message,setMessage] = useState('');
  useEffect(()=>{ if(recovery) setMode('update'); },[recovery]);
  const submit = async (e:React.FormEvent) => {
    e.preventDefault(); setMessage('');
    if(!client){setMessage('認証サービスの接続情報を設定してください。');return;}
    if((mode==='signup'||mode==='update')&&password.length<10){setMessage('パスワードは10文字以上で設定してください。');return;}
    if((mode==='signup'||mode==='update')&&password!==confirm){setMessage('確認用パスワードが一致しません。');return;}
    setBusy(true);
    if(mode==='login'){
      const {data,error}=await client.auth.signInWithPassword({email,password});
      if(error)setMessage('メールアドレスまたはパスワードを確認してください。'); else onAuthenticated(data.user.email??email);
    } else if(mode==='signup'){
      const {error}=await client.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin}});
      setMessage(error?'登録できませんでした。入力内容をご確認ください。':'確認メールを送信しました。メール内のリンクを開いてください。');
    } else if(mode==='reset'){
      const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin});
      setMessage(error?'再発行メールを送信できませんでした。':'パスワード再設定メールを送信しました。');
    } else {
      const {error}=await client.auth.updateUser({password});
      if(error)setMessage('パスワードを更新できませんでした。'); else {setMessage('パスワードを更新しました。');onRecoveryDone();setMode('login');}
    }
    setBusy(false);
  };
  const title=mode==='login'?'おかえりなさい':mode==='signup'?'アカウントを作成':mode==='reset'?'パスワードを再設定':'新しいパスワード';
  return <section className="auth-screen" aria-label="ログイン"><div className="auth-backdrop"/><div className="auth-card"><div className="auth-brand"><span>@</span><b>MENSION</b><small>メンション</small></div><div className="auth-heading"><p>SECURE ACCESS</p><h1>{title}</h1><span>{mode==='login'?'あなたの営業資産へ、安全にアクセス':mode==='reset'?'登録メールアドレスへ再設定リンクを送ります':'安全なアカウントで営業情報を管理'}</span></div><form onSubmit={submit}>{mode!=='update'&&<label><span>メールアドレス</span><input type="email" autoComplete="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="name@company.jp"/></label>}{mode!=='reset'&&<label><span>{mode==='update'?'新しいパスワード':'パスワード'}</span><input type="password" autoComplete={mode==='login'?'current-password':'new-password'} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="10文字以上"/></label>}{(mode==='signup'||mode==='update')&&<label><span>パスワード（確認）</span><input type="password" autoComplete="new-password" required value={confirm} onChange={e=>setConfirm(e.target.value)} placeholder="もう一度入力"/></label>}{message&&<div className="auth-message" role="status">{message}</div>}<button className="auth-submit" disabled={busy}>{busy?'処理中…':mode==='login'?'ログイン':mode==='signup'?'無料で始める':mode==='reset'?'再設定メールを送る':'パスワードを更新'}</button></form><div className="auth-links">{mode==='login'&&<><button onClick={()=>setMode('reset')}>パスワードを忘れた方</button><button onClick={()=>setMode('signup')}>新規アカウント作成</button></>}{mode!=='login'&&mode!=='update'&&<button onClick={()=>{setMode('login');setMessage('')}}>ログインへ戻る</button>}</div>{!client&&process.env.NODE_ENV==='development'&&<button className="preview-login" onClick={()=>onAuthenticated('preview@mension.local')}>ローカルプレビューを開く</button>}<div className="auth-security"><span>◆</span><small>暗号化通信・安全なパスワード管理・ユーザー別データ保護</small></div></div></section>;
}
