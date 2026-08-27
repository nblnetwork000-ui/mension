import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function isUnsafeHost(hostname:string) {
  return hostname==='localhost'||hostname.endsWith('.local')||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)||hostname==='::1';
}

function clean(value:string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
}

export async function GET(request:NextRequest) {
  const input=request.nextUrl.searchParams.get('url')?.trim();
  if(!input)return NextResponse.json({error:'URL is required'},{status:400});
  let url:URL;
  try{url=new URL(/^https?:\/\//i.test(input)?input:`https://${input}`);}catch{return NextResponse.json({error:'Invalid URL'},{status:400});}
  if(!['http:','https:'].includes(url.protocol)||isUnsafeHost(url.hostname))return NextResponse.json({error:'Unsupported URL'},{status:400});
  try{
    const response=await fetch(url,{headers:{'user-agent':'MENSION Site Reader/1.0','accept':'text/html'},redirect:'follow',signal:AbortSignal.timeout(8000)});
    const type=response.headers.get('content-type')||'';
    if(!response.ok||!type.includes('text/html'))throw new Error('fetch failed');
    const html=(await response.text()).slice(0,900000);
    const title=clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
    const description=clean(html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1]||html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1]||'');
    const body=clean(html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]||'');
    const sentences=body.split(/(?<=[。！？.!?])\s*/).filter(s=>s.length>=20&&s.length<=180).slice(0,3).join(' ');
    const summary=[title&&`${title}。`,description||sentences].filter(Boolean).join(' ').slice(0,600);
    return NextResponse.json({title,summary:summary||'サイトから概要文を取得できませんでした。手入力してください。'});
  }catch{return NextResponse.json({error:'Could not read website'},{status:422});}
}
