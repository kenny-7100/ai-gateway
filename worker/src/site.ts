/** Public editorial pages, independent of API configuration and credentials. */
const articles = [
  {
    slug: 'context-is-a-working-set', tag: 'CONTEXT ENGINEERING', number: '01', title: '上下文，是模型的工作台。',
    summary: '更长的上下文不一定带来更好的答案。把任务、证据与约束放在正确的位置，往往更有帮助。',
    reading: '4 分钟阅读',
    paragraphs: [
      ['从任务开始，而不是从资料开始', '在让模型阅读一大段资料之前，先说明要做出的决定。是找出接口变更的影响，还是比较两种实现的取舍？明确任务之后，模型才能判断哪些信息值得关注。'],
      ['给证据一个清晰的位置', '把已确认的事实、待验证的假设和希望模型完成的操作分别写清楚。代码片段应带上文件位置，运行结果应说明执行条件。这样既方便模型引用，也方便你检查结论是否有依据。'],
      ['维护一个小而准确的工作集', '随着任务推进，旧假设可能失效。定期更新当前目标、已确认的结论和下一步，比不断追加所有历史记录更有效。对于仓库任务，可以用一份简短的项目说明记录构建命令、架构边界和团队约定。'],
      ['让结论回到证据', '要求模型指出判断来自哪段代码、哪条测试或哪份文档。当依据不足时，把它标记为需要验证的问题。上下文管理的目的，是让每一步判断都更容易复查。'],
    ],
  },
  {
    slug: 'streaming-beyond-the-first-token', tag: 'ENGINEERING NOTES', number: '02', title: '流式体验，不止是首个 token。',
    summary: '从首段输出到完整结束，理解流式响应的几个时刻，也理解一次请求真正的完成方式。',
    reading: '3 分钟阅读',
    paragraphs: [
      ['先区分几个不同的时刻', '连接建立、收到响应头、收到第一个事件和看到第一段文本，是不同的事情。只记录一个总耗时，很难判断等待发生在网络、排队还是生成阶段。'],
      ['把事件当作连续的数据流', '网络数据块并不对应完整的消息。一个事件可能被拆成多段，多个事件也可能一起到达。解析时应维护缓冲区，并按照协议中的事件边界处理，而不是假设每次读取都有完整的 JSON。'],
      ['为中断留出空间', '用户取消、网络断开和上游失败，都可能发生在输出中途。界面应区分“生成完成”和“连接结束”，保留已经展示的内容，同时明确说明是否可以继续或重试。'],
      ['测量完整的使用体验', '除了首段文本耗时，还可以观察事件间隔、完成率和取消响应时间。工具调用期间可能没有可展示的正文，合适的状态提示能让这段等待更容易理解。'],
    ],
  },
  {
    slug: 'tools-with-clear-boundaries', tag: 'AGENT WORKFLOWS', number: '03', title: '让工具调用拥有清晰边界。',
    summary: '一个可验证的小循环：提出操作、执行工具、检查结果，再决定下一步。',
    reading: '4 分钟阅读',
    paragraphs: [
      ['把操作描述具体', '工具定义应该说明输入、输出和可能产生的副作用。相比一个可以执行任意操作的大接口，职责明确的小工具通常更容易调试，也更方便判断一次调用是否符合任务目标。'],
      ['执行结果也是上下文', '工具返回成功状态，并不等于用户目标已经完成。模型需要读取结果，检查预期是否成立，再决定继续、修正或结束。测试通过、文件存在、服务返回预期状态，都是不同层面的证据。'],
      ['区分可恢复操作与外部影响', '读取文件和运行本地检查，通常可以反复执行。发送消息、发布内容或修改共享数据，则需要结合用户授权和具体影响来处理。把这些边界写入工作流，会让自动化更可控。'],
      ['用小任务验证整个循环', '先验证模型能否选择工具、传入参数、读取返回值，并据此给出正确结论。对于编码助手，一个读取临时文件的小任务就能覆盖这个循环，再逐步增加任务复杂度。'],
    ],
  },
];

const css = `
:root{color-scheme:light;--paper:#f7f6f0;--ink:#223a30;--muted:#69736a;--line:#d8ded2;--accent:#d9ed91}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}a{color:inherit;text-decoration:none}a:focus-visible{outline:3px solid #668942;outline-offset:6px}a:hover .arrow{transform:translateX(5px)}.wrap{max-width:1120px;margin:auto;padding:0 38px}header{display:flex;align-items:center;justify-content:space-between;padding:27px 0;border-bottom:1px solid var(--line)}.brand{font-size:18px;font-weight:750;letter-spacing:2px}.brand span{font-weight:400;color:var(--muted);font-size:11px;letter-spacing:1px;margin-left:12px}nav{display:flex;gap:25px;font-size:13px}nav a:hover,.back:hover{text-decoration:underline;text-underline-offset:5px}.eyebrow{font:11px/1.5 ui-monospace,SFMono-Regular,monospace;letter-spacing:2px;text-transform:uppercase}.hero{padding:72px 0 54px;display:grid;grid-template-columns:1.7fr 1fr;gap:60px;align-items:center}.dot{display:inline-block;width:7px;height:7px;background:#6b8952;border-radius:50%;margin-right:9px}h1{font-size:clamp(36px,5vw,60px);line-height:1.25;letter-spacing:-2px;margin:23px 0;font-weight:650}h1 em{font-style:normal;color:#788d57}.lead{color:var(--muted);font-size:15px;max-width:500px}.visual{position:relative;aspect-ratio:1;background:#e8eddd;border:1px solid #d7dfcb;border-radius:50%;display:grid;place-items:center;overflow:hidden}.visual:before,.visual:after{content:"";position:absolute;width:73%;height:73%;border:1px solid #b3c49f;border-radius:50%;transform:translateX(-23%)}.visual:after{transform:translateX(23%)}.orbit{position:absolute;border:1px solid #b3c49f;width:92%;height:32%;border-radius:50%;transform:rotate(-35deg)}.visual strong{font:italic 100px/1 Georgia,serif;z-index:1;letter-spacing:-12px;padding-right:12px}.visual-label{text-align:right;font:10px/1.5 ui-monospace,monospace;letter-spacing:2px;color:var(--muted);margin-top:13px}.section-top{display:flex;justify-content:space-between;align-items:center;padding:20px 0;border-top:1px solid var(--line)}.section-top h2{font-size:14px;font-weight:500;margin:0}.section-top span{color:var(--muted);font:11px ui-monospace,monospace}.featured{background:var(--ink);color:var(--paper);padding:36px 40px;display:grid;grid-template-columns:1fr auto;gap:20px;align-items:center;border-radius:3px}.featured .eyebrow{color:var(--accent)}.featured h2{font-size:30px;line-height:1.4;margin:15px 0}.featured p{font-size:14px;color:#c3cdc1;max-width:650px;margin:0}.arrow{display:inline-block;transition:transform .2s}.featured .arrow{font-size:35px;color:var(--accent)}.cards{display:grid;grid-template-columns:1fr 1fr;gap:35px;margin-top:30px}.card{display:block;border-bottom:1px solid var(--line);padding:12px 0 27px}.card .eyebrow{color:var(--muted)}.card h2{font-size:23px;line-height:1.5;margin:15px 0 12px}.card p{font-size:14px;color:var(--muted);margin:0 0 20px}.meta{display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.about{display:grid;grid-template-columns:1fr 2fr;gap:35px;margin:68px 0 55px;border-top:1px solid var(--line);padding-top:25px}.about h2{font-size:17px;font-weight:500;margin:0}.about p{font-size:14px;color:var(--muted);margin:0;max-width:620px}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid var(--line);padding:23px 0 30px;font-size:11px;color:var(--muted)}.article{max-width:750px;margin:45px auto 70px}.back{font-size:13px;color:var(--muted)}.article h1{font-size:clamp(32px,5vw,46px);letter-spacing:-1px;margin:22px 0}.article .intro{font-size:17px;color:var(--muted);padding-bottom:28px;border-bottom:1px solid var(--line)}.article section{margin-top:35px}.article h2{font-size:21px;font-weight:600}.article p{font-size:16px;line-height:2;color:#47574c}.article .eyebrow{margin-top:35px;color:var(--muted)}.endnote{margin-top:45px;padding:20px 24px;background:#e8eddd;font-size:13px;color:var(--muted)}@media(max-width:650px){.wrap{padding:0 22px}header{padding:22px 0}.brand span{display:none}nav{gap:18px}.hero{padding:45px 0 35px;gap:20px;grid-template-columns:1fr}.hero h1{font-size:40px}.art{display:none}.featured{padding:26px;gap:12px}.featured h2{font-size:25px}.cards{grid-template-columns:1fr;gap:12px}.about{grid-template-columns:1fr;gap:15px;margin-top:45px}footer{flex-direction:column;gap:3px}.article{margin-top:30px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.arrow{transition:none}}`;

function shell(title: string, description: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f6f0"><meta name="description" content="${description}"><title>${title} · Jimao Notes</title><style>${css}</style></head><body><div class="wrap"><header><a class="brand" href="/" aria-label="Jimao Notes 首页">JIMAO<span>NOTES ON AI</span></a><nav aria-label="主导航"><a href="/#notes">文章</a><a href="/#about">关于</a></nav></header>${content}<footer><span>JIMAO NOTES · 关于 AI，也关于如何使用 AI。</span><span>保持好奇，持续验证。</span></footer></div></body></html>`;
}

function home(): string {
  const first = articles[0]!;
  return shell('AI 实践与工程笔记', '关于大语言模型、上下文工程和智能体工作流的实践笔记。', `<main><div class="hero"><div><div class="eyebrow"><span class="dot"></span>A SMALL NOTEBOOK FOR BIG IDEAS</div><h1>理解 AI，<br>从每一次<em>实践</em>开始。</h1><p class="lead">记录大语言模型、开发工具与智能体工作流中的思考。<br>把复杂概念拆开，把有用的方法留下。</p></div><div class="art" aria-hidden="true"><div class="visual"><div class="orbit"></div><strong>ai</strong></div><div class="visual-label">IDEAS → EXPERIMENTS → NOTES</div></div></div><section id="notes" aria-label="文章列表"><div class="section-top"><h2>值得展开的几个话题</h2>FIELD NOTES / 001—003</div><a class="featured" href="/notes/${first.slug}"><div><div class="eyebrow">${first.tag} / NOTE ${first.number}</div><h2>${first.title}</h2><p>${first.summary}</p></div><span class="arrow" aria-hidden="true">↗</span></a><div class="cards">${articles.slice(1).map(article => `<a class="card" href="/notes/${article.slug}"><div class="eyebrow">${article.tag} / ${article.number}</div><h2>${article.title}</h2><p>${article.summary}</p><div class="meta"><span>${article.reading}</span><span>阅读全文 <span class="arrow" aria-hidden="true">→</span></span></div></a>`).join('')}</div></section><section class="about" id="about"><h2>一个持续更新的笔记本。</h2><p>这里关注 AI 在实际工作中的使用方式：怎样组织上下文，怎样理解流式交互，以及怎样让工具调用更容易验证。文章从具体问题出发，保留可以复用的思路，也为尚未解决的问题留一个位置。</p></section></main>`);
}

export function siteResponse(request: Request, pathname: string): Response | undefined {
  if (!['GET', 'HEAD'].includes(request.method)) return;
  let html: string;
  if (pathname === '/' || pathname === '/notes' || pathname === '/notes/') html = home();
  else {
    const article = articles.find(item => pathname === `/notes/${item.slug}` || pathname === `/notes/${item.slug}/`);
    if (!article) return;
    html = shell(article.title, article.summary, `<main class="article"><a class="back" href="/#notes">← 返回全部文章</a><div class="eyebrow">${article.tag} / NOTE ${article.number} · ${article.reading}</div><h1>${article.title}</h1><p class="intro">${article.summary}</p>${article.paragraphs.map(([heading, paragraph]) => `<section><h2>${heading}</h2><p>${paragraph}</p></section>`).join('')}<div class="endnote">从一个小问题开始，做一次可以验证的实验。</div></main>`);
  }
  return new Response(request.method === 'HEAD' ? null : html, { headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  } });
}
