import { NextRequest, NextResponse } from 'next/server';

export const dynamic='force-dynamic';

type R2Object={body:BodyInit;httpEtag?:string;httpMetadata?:{contentType?:string}};
type R2Bucket={get:(key:string)=>Promise<R2Object|null>;put:(key:string,value:ArrayBuffer,options?:{httpMetadata?:{contentType?:string}})=>Promise<unknown>};

async function authorize(request:NextRequest){
  const supabaseUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;const publishableKey=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;const authorization=request.headers.get('authorization');
  if(!supabaseUrl||!publishableKey||!authorization?.startsWith('Bearer '))return null;
  const response=await fetch(`${supabaseUrl}/auth/v1/user`,{headers:{authorization,apikey:publishableKey}});if(!response.ok)return null;
  const user=await response.json();return String(user.id||'')||null;
}

function bucket(){return (process.env as unknown as {FILES?:R2Bucket}).FILES;}
function safeId(value:string){return /^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:null;}

export async function PUT(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const userId=await authorize(request);const id=safeId((await params).id);const files=bucket();if(!userId)return NextResponse.json({error:'Unauthorized'},{status:401});if(!id||!files)return NextResponse.json({error:'Storage unavailable'},{status:503});
  const contentType=request.headers.get('content-type')||'';const size=Number(request.headers.get('content-length')||0);if(contentType!=='image/jpeg'||size>1_500_000)return NextResponse.json({error:'Invalid image'},{status:400});
  const bytes=await request.arrayBuffer();if(!bytes.byteLength||bytes.byteLength>1_500_000)return NextResponse.json({error:'Invalid image'},{status:400});
  await files.put(`cards/${userId}/${id}.jpg`,bytes,{httpMetadata:{contentType:'image/jpeg'}});return NextResponse.json({ok:true});
}

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
  const userId=await authorize(request);const id=safeId((await params).id);const files=bucket();if(!userId)return NextResponse.json({error:'Unauthorized'},{status:401});if(!id||!files)return NextResponse.json({error:'Storage unavailable'},{status:503});
  const object=await files.get(`cards/${userId}/${id}.jpg`);if(!object)return NextResponse.json({error:'Not found'},{status:404});
  return new NextResponse(object.body,{headers:{'content-type':object.httpMetadata?.contentType||'image/jpeg','cache-control':'private, max-age=300','etag':object.httpEtag||''}});
}
