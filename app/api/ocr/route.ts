import { NextRequest, NextResponse } from 'next/server';

export const dynamic='force-dynamic';

function averageConfidence(response:any){
  const values:number[]=[];
  for(const page of response?.fullTextAnnotation?.pages||[])for(const block of page.blocks||[])for(const paragraph of block.paragraphs||[])for(const word of paragraph.words||[])if(typeof word.confidence==='number')values.push(word.confidence);
  return values.length?Math.round(values.reduce((sum,value)=>sum+value,0)/values.length*100):80;
}

export async function POST(request:NextRequest){
  const visionKey=process.env.GOOGLE_CLOUD_VISION_API_KEY;
  const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const authorization=request.headers.get('authorization');
  if(!visionKey||!supabaseUrl||!publishableKey)return NextResponse.json({error:'OCR is not configured'},{status:503});
  if(!authorization?.startsWith('Bearer '))return NextResponse.json({error:'Unauthorized'},{status:401});
  const authResponse=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{authorization,apikey:publishableKey}});
  if(!authResponse.ok)return NextResponse.json({error:'Unauthorized'},{status:401});
  let image='';
  try{const body=await request.json();image=String(body.image||'');}catch{return NextResponse.json({error:'Invalid request'},{status:400});}
  if(!image||image.length>9_000_000||!/^[A-Za-z0-9+/=]+$/.test(image))return NextResponse.json({error:'Invalid image'},{status:400});
  const visionResponse=await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(visionKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requests:[{image:{content:image},features:[{type:'DOCUMENT_TEXT_DETECTION'}],imageContext:{languageHints:['ja','en']}}]})});
  const data=await visionResponse.json();
  const result=data?.responses?.[0];
  if(!visionResponse.ok||result?.error)return NextResponse.json({error:'OCR failed'},{status:502});
  return NextResponse.json({text:result?.fullTextAnnotation?.text||'',confidence:averageConfidence(result)},{headers:{'cache-control':'no-store'}});
}
