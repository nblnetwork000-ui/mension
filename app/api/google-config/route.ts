import { NextResponse } from 'next/server';

export const dynamic='force-dynamic';

export async function GET(){
  return NextResponse.json({clientId:process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID||''},{headers:{'cache-control':'no-store'}});
}
