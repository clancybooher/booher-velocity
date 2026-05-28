export async function onRequestPost(context) {
  const { request, env } = context;

  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), { status: 503, headers: CORS });
  }

  try {
    const { message, budget, transactions, history } = await request.json();

    if (!message || !message.trim()) {
      return new Response(JSON.stringify({ error: 'No message provided' }), { status: 400, headers: CORS });
    }

    // Build budget context
    let budgetContext = 'No budget data loaded yet.';
    if (budget && budget.cats && Object.keys(budget.cats).length > 0) {
      const lines = Object.entries(budget.cats).map(([cat, d]) => {
        const pct = d.budget > 0 ? Math.round((d.spent / d.budget) * 100) : 0;
        const status = pct >= 100 ? '🔴 OVER' : pct >= 80 ? '🟡 close' : '🟢 ok';
        return `  ${status} ${cat}: $${(d.spent || 0).toFixed(0)} spent of $${(d.budget || 0).toFixed(0)} budget — $${(d.remaining || 0).toFixed(0)} left`;
      });
      const totalLeft = (budget.totalBudget || 0) - (budget.totalSpent || 0);
      budgetContext = `This month's budget:\n${lines.join('\n')}\nOverall: $${(budget.totalSpent || 0).toFixed(0)} spent of $${(budget.totalBudget || 0).toFixed(0)} total — $${totalLeft.toFixed(0)} remaining`;
    }

    // Build transaction context
    let txnContext = 'No recent transactions available.';
    if (transactions && transactions.length > 0) {
      const recent = transactions.slice(0, 30);
      txnContext = `Recent ${recent.length} transactions:\n` + recent.map(t =>
        `  ${t.date || '—'} | ${t.vendor || 'Unknown'} | $${Math.abs(t.amount || 0).toFixed(2)} | ${t.category || 'Uncategorized'}`
      ).join('\n');
    }

    const systemPrompt = `You are Velocity AI — the personal finance assistant built into the Booher Velocity budget app for Clancy & Naomi Booher.

Your personality: warm, direct, Ramsey-style zero-based budgeting. No lectures, no guilt — just clear numbers and actionable advice. Keep answers short (2–4 sentences). Use dollar signs and real numbers when you have them.

${budgetContext}

${txnContext}

Answer their question about budget and spending. If you can't answer with the data available, say so clearly and suggest they snap more receipts to build up history.`;

    const model = env.GEMINI_MODEL || 'gemini-2.5-flash';

    // Build multi-turn conversation
    const contents = [];
    if (history && Array.isArray(history)) {
      for (const msg of history.slice(-12)) {
        contents.push({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content }],
        });
      }
    }
    contents.push({ role: 'user', parts: [{ text: message.trim() }] });

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 600,
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      return new Response(JSON.stringify({ error: 'Gemini API error', detail: errText }), { status: 502, headers: CORS });
    }

    const geminiData = await geminiRes.json();
    const reply = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      return new Response(JSON.stringify({ error: 'No response from AI' }), { status: 502, headers: CORS });
    }

    return new Response(JSON.stringify({ ok: true, reply: reply.trim() }), { headers: CORS });

  } catch (err) {
    console.error('Chat error:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}
