'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '../lib/supabase/client';

type Tab = 'home' | 'scan' | 'people' | 'history' | 'settings';
type Toast = { title: string; detail: string } | null;

const nav: {id: Tab; label: string; icon: string}[] = [
  {id:'home',label:'HOME',icon:'⌂'},{id:'scan',label:'名刺登録',icon:'▣'},{id:'people',label:'顧客',icon:'♙'},{id:'history',label:'送信履歴',icon:'✉'},{id:'settings',label:'設定',icon:'⚙'}
];

type Customer = {name:string;initial:string;company:string;role:string;email:string;status:string;time:string;tone:string};
type ScanResult = {company:string;name:string;role:string;department:string;email:string;phone:string;address:string;website:string;rawText:string;confidence:number};
type MailTemplate = {subject:string;body:string};
type UserProfile = {company:string;name:string;role:string;department:string;email:string;phone:string;website:string;companySummary:string};

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

const emptyScan: ScanResult = {company:'',name:'',role:'',department:'',email:'',phone:'',address:'',website:'',rawText:'',confidence:0};

function extractCard(text:string,confidence:number): ScanResult {
  const lines=text.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  const email=text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]??'';
  const phone=text.match(/(?:\+?81[-\s]?)?(?:0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})/)?.[0]??'';
  const website=text.match(/(?:https?:\/\/|www\.)[^\s]+/i)?.[0]?.replace(/[),。]+$/,'')??'';
  const company=lines.find(v=>/(株式会社|有限会社|合同会社|Inc\.?|LLC|Corporation|Co\.,?\s*Ltd)/i.test(v))??lines[0]??'';
  const role=lines.find(v=>/(代表|取締役|社長|部長|課長|主任|Manager|Director|CEO|President)/i.test(v))??'';
  const department=lines.find(v=>/(事業部|営業部|企画部|開発部|部門|Department|Division)/i.test(v))??'';
  const excluded=new Set([company,role,department,email,phone,website]);
  const name=lines.find(v=>!excluded.has(v)&&/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\s・]{3,18}$/u.test(v))??'';
  const address=lines.find(v=>/(都|道|府|県).*(市|区|町|村)|〒\s*\d{3}-?\d{4}/.test(v))??'';
  return {company,name,role,department,email,phone,address,website,rawText:text,confidence:Math.round(confidence)};
}

export default function Home() {
  const supabase = useMemo(() => createClient(), []);
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
  const [customers,setCustomers] = useState<Customer[]>([]);
  const [showTemplate,setShowTemplate] = useState(false);
  const [showProfile,setShowProfile] = useState(false);
  const [mailTemplate,setMailTemplate] = useState<MailTemplate>({subject:'【ご挨拶】本日はありがとうございました｜{{送信者名}}',body:'{{会社名}}\n{{氏名}} 様\n\n本日は貴重なお時間をいただき、ありがとうございました。\n{{AI生成文}}\n\n今後ともどうぞよろしくお願いいたします。'});
  const [profile,setProfile] = useState<UserProfile>({company:'',name:'',role:'',department:'',email:'',phone:'',website:'',companySummary:''});
  const [sendMode,setSendMode] = useState('confirm');
  const [autoGreeting,setAutoGreeting] = useState(true);
  const [signature,setSignature] = useState(true);
  const [companyContext,setCompanyContext] = useState(true);
  const filtered = useMemo(() => customers.filter(c => `${c.name}${c.company}${c.email}`.toLowerCase().includes(query.toLowerCase())),[query]);

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
        supabase.from('contacts').select('*').order('created_at',{ascending:false}),
        supabase.from('user_settings').select('mail_subject,mail_body').maybeSingle(),
        supabase.from('user_profiles').select('*').maybeSingle(),
      ]);
      if(!userData.user) return;
      if(contactRows) setCustomers(contactRows.map((row:any)=>({name:row.name||'氏名未確認',initial:(row.name||row.company||'@').slice(0,2),company:row.company||'会社名未確認',role:row.role||'',email:row.email||'',status:row.status||'確認待ち',time:new Date(row.created_at).toLocaleDateString('ja-JP'),tone:'gold'})));
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
      const worker=await createOcrWorker(m=>{if(m.status==='recognizing text')setOcrProgress(Math.round((m.progress||0)*100));});
      const result=await worker.recognize(file);
      await worker.terminate();
      const parsed=extractCard(result.data.text,result.data.confidence);
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
    const payload={user_id:userData.user.id,company:scanResult.company,name:scanResult.name,role:scanResult.role,department:scanResult.department,email:scanResult.email||null,phone:scanResult.phone,address:scanResult.address,website:scanResult.website,raw_text:scanResult.rawText,confidence:scanResult.confidence,status:scanResult.email?'未送信':'確認待ち'};
    const {data,error}=await supabase.from('contacts').insert(payload).select().single();
    if(error){notify('顧客を保存できませんでした',error.code==='23505'?'同じメールアドレスの顧客が登録済みです':'入力内容を確認してください');return;}
    setCustomers(prev=>[{name:data.name||'氏名未確認',initial:(data.name||data.company||'@').slice(0,2),company:data.company||'会社名未確認',role:data.role||'',email:data.email||'',status:data.status,time:'今',tone:'gold'},...prev]);
    setScanResult(null); setTab('people'); notify('顧客データへ保存しました','ユーザー専用の顧客リストへ追加しました');
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

    {tab==='home' && <HomeView go={setTab} notify={notify} />}
    {tab==='scan' && <ScanView processing={processing} progress={ocrProgress} upload={upload} notify={notify} result={scanResult} setResult={setScanResult} save={saveContact} />}
    {tab==='people' && <PeopleView query={query} setQuery={setQuery} customers={filtered} notify={notify} />}
    {tab==='history' && <HistoryView notify={notify} />}
    {tab==='settings' && <SettingsView sendMode={sendMode} setSendMode={setSendMode} autoGreeting={autoGreeting} setAutoGreeting={setAutoGreeting} signature={signature} setSignature={setSignature} companyContext={companyContext} setCompanyContext={setCompanyContext} notify={notify} onOpenGuide={()=>setShowGuide(true)} onOpenTemplate={()=>setShowTemplate(true)} onOpenProfile={()=>setShowProfile(true)} />}

    <nav className="bottom-nav" aria-label="メインメニュー">{nav.map(item=><button key={item.id} className={tab===item.id?'active':''} onClick={()=>setTab(item.id)}><span>{item.icon}</span><small>{item.label}</small></button>)}</nav>
    {currentUser&&showGuide&&<OnboardingGuide onClose={closeGuide}/>} 
    {showTemplate&&<TemplateEditor value={mailTemplate} onClose={()=>setShowTemplate(false)} onSave={saveTemplate}/>} 
    {showProfile&&<ProfileEditor value={profile} onClose={()=>setShowProfile(false)} onSave={saveProfile}/>} 
    {toast&&<div className="toast" role="status"><span>✓</span><div><strong>{toast.title}</strong><small>{toast.detail}</small></div></div>}
  </main>;
}

function PageHead({kicker,title,sub}:{kicker:string;title:string;sub?:string}) { return <div className="page-head"><p>{kicker}</p><h1>{title}</h1>{sub&&<span>{sub}</span>}</div>; }

function HomeView({go,notify}:{go:(t:Tab)=>void;notify:(a:string,b:string)=>void}) {
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

function PeopleView({query,setQuery,customers,notify}:{query:string;setQuery:(v:string)=>void;customers:Array<{name:string;initial:string;company:string;role:string;email:string;status:string;time:string;tone:string}>;notify:(a:string,b:string)=>void}) {
  return <section className="screen"><PageHead kicker="CONTACTS" title="顧客リスト" sub={`${customers.length}件のコンタクト`}/><div className="search"><span>⌕</span><input aria-label="顧客を検索" value={query} onChange={e=>setQuery(e.target.value)} placeholder="氏名・会社名・メールで検索"/><button onClick={()=>notify('フィルター','登録日・送信状態・担当者で絞り込めます')}>絞込</button></div><div className="filter-chips"><button className="selected">すべて</button><button>確認待ち 0</button><button>送信済み</button><button>未送信</button></div>
    <div className="people-list">{customers.length===0?<div className="empty-state compact-empty"><span>♙</span><strong>顧客はまだ登録されていません</strong><small>名刺を読み取ると自動で顧客リストに追加されます</small></div>:customers.map(c=><article key={c.email} onClick={()=>notify(c.name,`${c.company}の詳細を開きました`)}><span className={`initial ${c.tone}`}>{c.initial}</span><div><strong>{c.name}<i className={`dot ${c.status==='確認待ち'?'amber':''}`}/></strong><small>{c.company} ・ {c.role}</small><a>{c.email}</a></div><button aria-label={`${c.name}の詳細`}>›</button></article>)}</div>
    <button className="export-btn" onClick={()=>notify('CSVを書き出しました','顧客データを安全にエクスポートしました')}>↓　CSVエクスポート</button>
  </section>;
}

function HistoryView({notify}:{notify:(a:string,b:string)=>void}) { return <section className="screen"><PageHead kicker="MAIL ACTIVITY" title="送信履歴" sub="送信履歴はまだありません"/><div className="mail-overview"><div><small>THIS MONTH</small><strong>0<em>通</em></strong><span>名刺登録から始めましょう</span></div><div className="ring"><b>—</b><small>SUCCESS</small></div></div><div className="timeline"><h3>履歴</h3><div className="empty-state compact-empty"><span>✉</span><strong>メールはまだ送信されていません</strong><small>送信すると、この画面から結果を確認できます</small></div></div></section>; }

function SettingsView({sendMode,setSendMode,autoGreeting,setAutoGreeting,signature,setSignature,companyContext,setCompanyContext,notify,onOpenGuide,onOpenTemplate,onOpenProfile}:{sendMode:string;setSendMode:(v:string)=>void;autoGreeting:boolean;setAutoGreeting:(v:boolean)=>void;signature:boolean;setSignature:(v:boolean)=>void;companyContext:boolean;setCompanyContext:(v:boolean)=>void;notify:(a:string,b:string)=>void;onOpenGuide:()=>void;onOpenTemplate:()=>void;onOpenProfile:()=>void}) { return <section className="screen settings"><PageHead kicker="PREFERENCES" title="設定" sub="あなたらしいフォローを自動化"/>
    <button className="guide-setting" onClick={onOpenGuide}><span>?</span><div><strong>MENSIONの使い方</strong><small>名刺登録からメール送信までを確認</small></div><b>見る</b></button>
    <div className="settings-group"><h3>送信モード</h3><p>名刺読み取り後の動作を選択</p><div className="mode-select">{[['auto','完全自動','読み取り後すぐ送信'],['confirm','確認して送信','内容を確認してから'],['off','送信なし','リスト登録のみ']].map(m=><button key={m[0]} onClick={()=>setSendMode(m[0])} className={sendMode===m[0]?'selected':''}><i>{sendMode===m[0]?'●':'○'}</i><span><strong>{m[1]}</strong><small>{m[2]}</small></span></button>)}</div></div>
    <button className="setting-row" onClick={()=>notify('送信元メール','Google Workspaceが正常に接続されています')}><span className="setting-icon">@</span><div><strong>送信元メール</strong><small>taro@premium-sales.jp</small></div><em className="connected">接続済み</em><b>›</b></button>
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

function ProfileEditor({value,onClose,onSave}:{value:UserProfile;onClose:()=>void;onSave:(v:UserProfile)=>void}) {
  const [draft,setDraft]=useState(value);const [reading,setReading]=useState(false);const [summarizing,setSummarizing]=useState(false);const [message,setMessage]=useState('');
  const readCard=async(e:ChangeEvent<HTMLInputElement>)=>{const file=e.target.files?.[0];if(!file)return;setReading(true);setMessage('名刺を読み取っています…');try{const worker=await createOcrWorker();const result=await worker.recognize(file);await worker.terminate();const card=extractCard(result.data.text,result.data.confidence);setDraft(v=>({...v,company:card.company,name:card.name,role:card.role,department:card.department,email:card.email,phone:card.phone,website:card.website||v.website}));setMessage('名刺の内容を入力しました。確認して保存してください。');}catch{setMessage('読み取れませんでした。明るい場所で撮り直してください。');}finally{setReading(false);e.target.value='';}};
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
