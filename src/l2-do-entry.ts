/**
 * PAI-Memory L2 Episodic Chain & Interactive WikiGraphNodes Gateway
 * memory.axiomid.app
 */

import { L2EpisodicDO, L2Client } from '../packages/pai-memory-core/src/l2-do-adapter';

export { L2EpisodicDO, L2Client } from '../packages/pai-memory-core/src/l2-do-adapter';
export type { L2DOConfig, L2DOState, L2EntryRow } from '../packages/pai-memory-core/src/l2-do-adapter';

const MEMORY_GRAPH_NODES = [
  { id: "L1", name: "L1 Working Memory", type: "Drain Ring Capsule", latency: "<1ms", capacity: "256KB Hard", decay: "LRU / Pin", x: 150, y: 120 },
  { id: "L2", name: "L2 Episodic Chain", type: "Episodic Adjacency", latency: "5ms", capacity: "10GB DO SQLite", decay: "Power-law β=1.2", x: 380, y: 80 },
  { id: "L3", name: "L3 Fact Graph", type: "HNSW Small-World Graph", latency: "15ms", capacity: "0.5-2GB Vectorize", decay: "Power-law t^(-β)", x: 620, y: 120 },
  { id: "L4", name: "L4 Procedural Code", type: "Dendritic Call-Graph", latency: "10ms", capacity: "5GB D1 Database", decay: "Near-Persist", x: 750, y: 280 },
  { id: "L5", name: "L5 Trust Ledger", type: "Hash-Chain Immutable", latency: "2ms", capacity: "Unbounded Sigstore", decay: "Zero Decay", x: 620, y: 440 },
  { id: "L6", name: "L6 Shared Edge", type: "Energy-Gossip Propagation", latency: "20ms", capacity: "KV Session Region", decay: "Gossip-Sync", x: 380, y: 480 },
  { id: "L7", name: "L7 Cold Archive", type: "Bitemporal Parquet", latency: "100ms", capacity: "Unbounded R2", decay: "Never", x: 150, y: 440 },
];

const MEMORY_GRAPH_EDGES = [
  { from: "L1", to: "L2", label: "LRU Overflow" },
  { from: "L2", to: "L3", label: "Fact Lifting" },
  { from: "L3", to: "L4", label: "AST Symlink" },
  { from: "L3", to: "L5", label: "Trust Anchor" },
  { from: "L5", to: "L6", label: "Gossip Sync" },
  { from: "L6", to: "L7", label: "Cold Parquet" },
  { from: "L7", to: "L1", label: "Rehydrate" },
];

const PAGE_HTML = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PAI Memory — 7-Layer WikiGraphNodes Engine (memory.axiomid.app)</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-base: #020617;
    --bg-card: rgba(15, 23, 42, 0.75);
    --border-glass: rgba(255, 255, 255, 0.08);
    --border-glass-hover: rgba(56, 189, 248, 0.4);
    --text-primary: #f8fafc;
    --text-secondary: #94a3b8;
    --accent-sky: #38bdf8;
    --accent-cyan: #2dd4bf;
    --accent-purple: #c084fc;
    --font-sans: 'Inter', system-ui, sans-serif;
    --font-mono: 'Fira Code', monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background-color: var(--bg-base);
    background-image: 
      radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.08) 0%, transparent 45%),
      radial-gradient(circle at 80% 80%, rgba(192, 132, 252, 0.08) 0%, transparent 45%),
      linear-gradient(rgba(255, 255, 255, 0.015) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.015) 1px, transparent 1px);
    background-size: 100% 100%, 100% 100%, 32px 32px, 32px 32px;
    color: var(--text-primary);
    font-family: var(--font-sans);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    border-bottom: 1px solid var(--border-glass);
    background: rgba(2, 6, 23, 0.85);
    backdrop-filter: blur(16px);
    position: sticky;
    top: 0;
    z-index: 50;
  }

  .header-inner {
    max-width: 1200px;
    margin: 0 auto;
    padding: 1rem 1.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .brand-logo {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    text-decoration: none;
    color: var(--text-primary);
    font-weight: 800;
    font-size: 1.25rem;
  }

  .brand-badge {
    padding: 0.25rem 0.65rem;
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.3);
    border-radius: 9999px;
    color: var(--accent-sky);
    font-size: 0.7rem;
    font-family: var(--font-mono);
    text-transform: uppercase;
  }

  .lang-btn {
    background: transparent;
    border: 1px solid var(--border-glass);
    color: var(--text-secondary);
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    font-size: 0.8rem;
    font-family: var(--font-mono);
    cursor: pointer;
    transition: all 0.2s;
  }

  .lang-btn:hover {
    border-color: var(--accent-sky);
    color: var(--accent-sky);
  }

  main {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 2.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 2.5rem;
  }

  .hero-card {
    background: var(--bg-card);
    border: 1px solid var(--border-glass);
    backdrop-filter: blur(20px);
    border-radius: 1.5rem;
    padding: 2.5rem;
    position: relative;
    overflow: hidden;
  }

  .hero-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--accent-sky), var(--accent-cyan), var(--accent-purple));
  }

  .hero-title {
    font-size: clamp(2rem, 3.5vw, 2.75rem);
    font-weight: 800;
    line-height: 1.15;
    letter-spacing: -0.03em;
    background: linear-gradient(135deg, #ffffff 40%, var(--text-secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 1rem;
  }

  .graph-wrapper {
    background: #010409;
    border: 1px solid var(--border-glass);
    border-radius: 1.25rem;
    padding: 1.5rem;
    position: relative;
    overflow: hidden;
  }

  svg.wiki-graph {
    width: 100%;
    height: 550px;
  }

  .node-circle {
    fill: rgba(15, 23, 42, 0.9);
    stroke: var(--accent-sky);
    stroke-width: 2.5;
    cursor: pointer;
    transition: all 0.3s ease;
  }

  .node-circle:hover {
    fill: rgba(56, 189, 248, 0.2);
    stroke: var(--accent-purple);
    filter: drop-shadow(0 0 12px rgba(56, 189, 248, 0.6));
  }

  .edge-line {
    stroke: rgba(255, 255, 255, 0.15);
    stroke-width: 1.5;
    stroke-dasharray: 4;
    animation: dash 20s linear infinite;
  }

  @keyframes dash {
    to { stroke-dashoffset: -100; }
  }

  footer {
    border-top: 1px solid var(--border-glass);
    padding: 2rem 1.5rem;
    text-align: center;
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-family: var(--font-mono);
  }
</style>
</head>
<body>

<header>
  <div class="header-inner">
    <a href="/" class="brand-logo">
      <span>PAI Memory Engine</span>
      <span class="brand-badge">memory.axiomid.app</span>
    </a>
    <button class="lang-btn" id="lang-toggle" onclick="toggleLanguage()">AR / العربية</button>
  </div>
</header>

<main>
  <section class="hero-card">
    <h1 class="hero-title" id="hero-title">7-Layer WikiGraphNodes Memory Explorer</h1>
    <p style="color: var(--text-secondary); font-size: 1rem; line-height: 1.6;" id="hero-desc">
      PAI-Memory ("Momerino") materializes agent context across 7 natural lifecycle layers using Cloudflare Durable Objects, D1, KV, Vectorize, and R2 Parquet archives.
    </p>
  </section>

  <section class="graph-wrapper">
    <h2 style="font-size: 1.1rem; font-weight: 700; margin-bottom: 1rem; color: var(--accent-sky);" id="graph-title">🌐 Interactive Memory Topology Graph</h2>
    <svg class="wiki-graph" viewBox="0 0 900 550" id="graph-svg"></svg>
  </section>
</main>

<footer>
  <p id="footer-text">memory.axiomid.app · PAI Universe 7-Layer Memory Standard · Built with Ihsan</p>
</footer>

<script>
const nodes = ${JSON.stringify(MEMORY_GRAPH_NODES)};
const edges = ${JSON.stringify(MEMORY_GRAPH_EDGES)};
let currentLang = 'en';

const i18n = {
  en: {
    heroTitle: "7-Layer WikiGraphNodes Memory Explorer",
    heroDesc: "PAI-Memory (\"Momerino\") materializes agent context across 7 natural lifecycle layers using Cloudflare Durable Objects, D1, KV, Vectorize, and R2 Parquet archives.",
    graphTitle: "🌐 Interactive Memory Topology Graph",
    footerText: "memory.axiomid.app · PAI Universe 7-Layer Memory Standard · Built with Ihsan"
  },
  ar: {
    heroTitle: "مستكشف شبكة الذاكرة الكسورية ذو الـ 7 طبقات",
    heroDesc: "يقوم محرك PAI-Memory كشجرة بيانية تفاعلية بتخزين وتنشيط ذاكرة وكلاء الذكاء الاصطناعي عبر 7 طبقات دورية باستخدام Cloudflare Durable Objects و D1 و R2.",
    graphTitle: "🌐 الرسم البياني لبيئة الذاكرة التفاعلية",
    footerText: "memory.axiomid.app · معيار الذاكرة السيادي لمنظومة PAI Universe · بنيت بإحسان"
  }
};

function renderGraph() {
  const svg = document.getElementById('graph-svg');
  let html = '';

  // Render edges
  edges.forEach(e => {
    const fromNode = nodes.find(n => n.id === e.from);
    const toNode = nodes.find(n => n.id === e.to);
    if (fromNode && toNode) {
      html += \`<line class="edge-line" x1="\${fromNode.x}" y1="\${fromNode.y}" x2="\${toNode.x}" y2="\${toNode.y}" />\`;
    }
  });

  // Render nodes
  nodes.forEach(n => {
    html += \`
      <g transform="translate(\${n.x}, \${n.y})">
        <circle class="node-circle" r="42" />
        <text text-anchor="middle" dy="-5" fill="#f8fafc" font-family="var(--font-mono)" font-size="11" font-weight="700">\${n.id}</text>
        <text text-anchor="middle" dy="14" fill="#38bdf8" font-family="var(--font-mono)" font-size="9">\${n.latency}</text>
        <title>\${n.name}\\nTopology: \${n.type}\\nCapacity: \${n.capacity}\\nDecay: \${n.decay}</title>
      </g>
    \`;
  });

  svg.innerHTML = html;
}

function toggleLanguage() {
  currentLang = currentLang === 'en' ? 'ar' : 'en';
  document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';
  document.getElementById('lang-toggle').textContent = currentLang === 'en' ? 'AR / العربية' : 'EN / English';
  const t = i18n[currentLang];
  document.getElementById('hero-title').textContent = t.heroTitle;
  document.getElementById('hero-desc').textContent = t.heroDesc;
  document.getElementById('graph-title').textContent = t.graphTitle;
  document.getElementById('footer-text').textContent = t.footerText;
}

renderGraph();
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ name: "pai-memory-engine", layers: 7, status: "live" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/explorer" || url.pathname === "/graph") {
      return new Response(PAGE_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const id = env.L2_EPISODIC_DO?.idFromName('l2-episodic-chain');
    if (id && env.L2_EPISODIC_DO) {
      const stub = env.L2_EPISODIC_DO.get(id);
      return stub.fetch(request);
    }

    return new Response(PAGE_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

interface Env {
  L2_EPISODIC_DO?: DurableObjectNamespace;
  DB?: D1Database;
}