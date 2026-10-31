// Fake OpenAI-compatible server for offline tests: answers with "### Component" blocks taken from the prompt.
import http from 'node:http';

export function startMockLLM(port = 0) {
  const stats = { calls: 0, images: 0, models: new Set(), auth: new Set() };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end('{"error":{"message":"not found"}}'); }
      const data = JSON.parse(body || '{}'); stats.calls++; stats.models.add(data.model); stats.auth.add(req.headers.authorization || '');
      const user = data.messages.find((m) => m.role === 'user');
      const parts = Array.isArray(user.content) ? user.content : [{ type: 'text', text: user.content }];
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const imgs = parts.filter((p) => p.type === 'image_url').length; stats.images += imgs;
      let answer;
      if (/## Дизайн-язык/.test(text)) {
        answer = ['## Дизайн-язык', '- (mock) Светлый SaaS-стиль, много воздуха, контейнер 1200px.', `- (mock) Получено скриншотов: ${imgs}.`, '## UI-примитивы', '```tsx', "export function Button({ children }: { children: React.ReactNode }) { return <button className=\"h-11 rounded-[10px] bg-primary px-5 text-white\">{children}</button>; }", '```', '## Порядок сборки', '1. (mock) Токены → layout → секции.', '## Риски', '- (mock) Шрифты и hover-состояния.', '## Дополнения к мастер-промпту', '- (mock) Сверяй отступы по скриншотам.'].join('\n');
      } else {
        const names = [...text.matchAll(/^### ([A-Z][A-Za-z0-9]+)\s*$/gm)].map((m) => m[1]);
        const reused = new Set([...text.matchAll(/^### ([A-Z][A-Za-z0-9]+)\nТип: [^\n]*общий компонент/gm)].map((m) => m[1]));
        answer = names.filter((n) => !reused.has(n)).map((n) => `### ${n}\n- **Визуал:** (mock) описание ${n}, скриншотов ${imgs}.\n- **Правки каркаса:** Каркас соответствует скриншоту.`).join('\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock', model: data.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }], usage: { prompt_tokens: Math.round(text.length / 4), completion_tokens: Math.round(answer.length / 4) } }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, stats, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
