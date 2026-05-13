export default function Page() {
  return (
    <div style={{ fontFamily: 'system-ui', padding: '2rem', color: '#333' }}>
      <h1>Pollar Pay API</h1>
      <p>This is the API backend. Use the SDK or Postman to interact with it.</p>
      <p><code>GET /api/sdk/status</code> — Check payment status</p>
      <p><code>POST /api/sdk/pay</code> — Create payment intent</p>
      <p><code>POST /api/sdk/manual-complete</code> — Manual completion</p>
    </div>
  );
}
