import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    service: 'pollar-pay-api',
    status: 'healthy',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
}
