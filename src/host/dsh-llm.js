/**
 * DSH 本体模型服务（ctx.llm）适配层。
 * 直接复用 DSH 已配置的提供商与模型列表，不单独维护 API Key / Base URL。
 */

export async function listHostLlmModels(hostLlm) {
  if (!hostLlm || typeof hostLlm.listProviders !== 'function') {
    return { ok: false, models: [], error: '当前未连接到 DSH 模型服务（ctx.llm）' };
  }
  const providers = await hostLlm.listProviders();
  const out = [];
  for (const p of (Array.isArray(providers) ? providers : [])) {
    const pid = String(p?.id ?? '');
    if (!pid) continue;
    const pname = String(p?.name ?? pid);
    let list = [];
    try {
      list = typeof hostLlm.listModels === 'function' ? await hostLlm.listModels(pid) : [];
    } catch {
      list = [];
    }
    for (const m of (Array.isArray(list) ? list : [])) {
      const mid = typeof m === 'string' ? m : String(m?.id ?? '');
      if (!mid) continue;
      const mname = typeof m === 'string' ? m : String(m?.name ?? mid);
      out.push({
        provider: pid,
        providerName: pname,
        model: mid,
        label: mname === mid ? `${pname} · ${mid}` : `${pname} · ${mname} (${mid})`,
      });
    }
  }
  return { ok: true, models: out };
}

export async function resolveHostRoute(hostLlm, { provider, model }) {
  const pid = typeof provider === 'string' ? provider.trim() : '';
  const mid = typeof model === 'string' ? model.trim() : '';
  if (!mid) throw new Error('请先选择 DSH 模型');
  if (pid) return { provider: pid, model: mid };

  const listed = await listHostLlmModels(hostLlm);
  if (listed.ok) {
    const match = listed.models.find((x) => x.model === mid);
    if (match) return { provider: match.provider, model: match.model };
  }
  const providers = typeof hostLlm?.listProviders === 'function' ? await hostLlm.listProviders() : [];
  const firstPid = String(providers?.[0]?.id ?? '');
  if (!firstPid) throw new Error('DSH 当前没有可用的模型提供商');
  return { provider: firstPid, model: mid };
}

export function createHostLlmAdapter(hostLlm, { provider, model }) {
  return {
    async complete(messages, opts = {}) {
      if (!hostLlm || typeof hostLlm.stream !== 'function') {
        throw new Error('当前未连接到 DSH 模型服务（ctx.llm）');
      }
      const route = await resolveHostRoute(hostLlm, { provider, model });
      const systemMsgs = [];
      const userParts = [];
      for (const m of (Array.isArray(messages) ? messages : [])) {
        const text = typeof m?.content === 'string' ? m.content : '';
        if (!text) continue;
        if (m.role === 'system') systemMsgs.push(text);
        else userParts.push(m.role === 'assistant' ? `[assistant]\n${text}` : text);
      }
      const system = systemMsgs.join('\n\n') || undefined;
      const userText = userParts.join('\n\n') || ' ';

      let out = '';
      for await (const chunk of hostLlm.stream({
        provider: route.provider,
        model: route.model,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'dsh-verbatim' } }],
        maxTokens: Number.isFinite(opts.maxTokens) ? opts.maxTokens : 512,
        signal: opts.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
          out += chunk.text;
        } else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(chunk.reason?.failure?.message || 'DSH LLM 调用失败');
        }
      }
      return out;
    },
  };
}
