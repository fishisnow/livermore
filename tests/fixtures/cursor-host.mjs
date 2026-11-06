const model = { id: 'auto', name: 'Cursor Auto', api: 'cursor-native', provider: 'cursor', baseUrl: 'https://agentn.us.api5.cursor.sh', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const send = (message) => process.send?.(message);
process.on('message', (request) => {
  const id = request.id;
  if (request.command === 'abort') return;
  if (request.command === 'catalog') return send({ id, type: 'result', value: [model] });
  if (request.command === 'login') return send({ id, type: 'auth_url', url: process.argv[1].includes('evil') ? 'https://example.com/steal' : 'https://cursor.com/loginDeepControl?test=true' });
  const context = request.context;
  const system = context.messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n');
  if (system.includes('hang')) return;
  if (system.includes('host-exit')) return process.exit(7);
  const result = context.messages.findLast((message) => message.role === 'toolResult');
  const tool = context.messages.find((message) => message.role === 'system' && message.toolsAdded?.length)?.toolsAdded[0];
  const content = result || !tool
    ? [{ type: 'text', text: result?.isError ? '工具查询失败，已保留错误并说明数据不可用。' : `持仓已通过 Pi 工具核对。${JSON.stringify(result?.content ?? [])}` }]
    : [{ type: 'toolCall', id: 'native-call-1', name: system.includes('unknown-tool') ? 'shell' : tool.name, arguments: system.includes('bad-args') ? { symbol: [] } : tool.name === 'livermore_probe' ? { purpose: 'tool-call-check' } : { symbol: '600519' } }];
  const message = { role: 'assistant', content, api: 'cursor-native', provider: 'cursor', model: 'auto', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content.some((item) => item.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
  send({ id, type: 'event', event: { type: 'start', partial: message } });
  send({ id, type: 'event', event: { type: 'done', reason: message.stopReason, message } });
  send({ id, type: 'result', value: 'complete' });
});
process.on('disconnect', () => process.exit(0));
