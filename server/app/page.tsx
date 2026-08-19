export default function Home() {
  return <main style={{ fontFamily: "system-ui", maxWidth: 560, margin: "15vh auto", padding: 24 }}><h1>PiHub Server</h1><p>服务正在运行，仅供 Tailnet 内的 PiHub 客户端访问。</p><p style={{ color: "#6b7280" }}>API: /api · 传输: Tailscale Serve · 公网: 已禁用</p></main>;
}
