// ─────────────────────────────────────────────────────────────────────────────
// LicitaControl — Envio automático diário
// Roda via GitHub Actions todo dia às 8h (horário de Brasília)
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────
const CONFIG = {
  pipedriveToken: process.env.PIPEDRIVE_TOKEN,
  emailjsServiceId: process.env.EMAILJS_SERVICE_ID,
  emailjsTemplateId: process.env.EMAILJS_TEMPLATE_ID,
  emailjsPublicKey: process.env.EMAILJS_PUBLIC_KEY,
  emailjsPrivateKey: process.env.EMAILJS_PRIVATE_KEY, // necessário para envio server-side
  teamEmails: (process.env.TEAM_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),
  companyName: process.env.COMPANY_NAME || 'RC Scientific',
  // Dias de antecedência para notificar (separado por vírgula)
  // Exemplos: '30' = só 30 dias antes | '5,15,30' = 3 avisos | '30,15,7,3,1' = 5 avisos
  alertDays: (process.env.ALERT_DAYS || '30').split(',').map(Number),
  // Texto do e-mail para o CLIENTE
  subjCliente: process.env.SUBJ_CLIENTE || 'Seu contrato {CONTRATO} está prestes a vencer',
  bodyCliente: process.env.BODY_CLIENTE || `Prezado(a) {NOME},

Gostaríamos de avisar que o contrato {CONTRATO} firmado com {EMPRESA} vence em {DIAS} dia(s), em {DATA}.

Esta é uma ótima oportunidade para renovar e garantir a continuidade dos seus serviços. A renovação antecipada também assegura as condições atuais de preço e disponibilidade.

Entre em contato conosco o quanto antes para não perder essa oportunidade.

Atenciosamente,
Equipe {EMPRESA}`,
  // Texto do e-mail para o TIME INTERNO
  subjTime: process.env.SUBJ_TIME || '[ALERTA] Contrato {CONTRATO} vence em {DIAS} dias',
  bodyTime: process.env.BODY_TIME || `Alerta de vencimento de contrato

Contrato: {CONTRATO}
Cliente: {NOME}
Vencimento: {DATA}
Prazo: {DIAS} dia(s)

Acesse o deal no Pipedrive:
{LINK_PIPEDRIVE}

—
LicitaControl · {EMPRESA}`,
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
function daysUntil(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric'
  });
}

function replaceVars(template, vars) {
  return template
    .replace(/{NOME}/g, vars.nome || '')
    .replace(/{CONTRATO}/g, vars.contrato || '')
    .replace(/{DIAS}/g, vars.dias != null ? String(vars.dias) : '')
    .replace(/{DATA}/g, vars.data || '')
    .replace(/{EMPRESA}/g, CONFIG.companyName)
    .replace(/{LINK_PIPEDRIVE}/g, vars.link || '');
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function httpPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── PIPEDRIVE ─────────────────────────────────────────────────────────────────
async function fetchDeals() {
  console.log('📡 Buscando pipelines no Pipedrive...');
  const pipesRes = await httpGet(`https://api.pipedrive.com/v1/pipelines?api_token=${CONFIG.pipedriveToken}`);
  const pipes = (pipesRes.data || []).filter(p =>
    p.name.toLowerCase().includes('licitaç') || p.name.toLowerCase().includes('licitac')
  );

  if (!pipes.length) {
    console.log('⚠ Nenhum funil "Licitações" encontrado — buscando todos os deals');
  } else {
    console.log(`✓ Funis encontrados: ${pipes.map(p => p.name).join(', ')}`);
  }

  let allDeals = [];
  const targets = pipes.length ? pipes : [{ id: null, name: 'Todos' }];

  for (const pipe of targets) {
    let start = 0;
    while (true) {
      let url = `https://api.pipedrive.com/v1/deals?api_token=${CONFIG.pipedriveToken}&status=open&limit=100&start=${start}`;
      if (pipe.id) url += `&pipeline_id=${pipe.id}`;
      const res = await httpGet(url);
      if (!res.success || !res.data) break;
      res.data.forEach(d => allDeals.push({ ...d, _pipe: pipe.name }));
      if (!res.additional_data?.pagination?.more_items_in_collection) break;
      start += 100;
    }
  }

  console.log(`✓ ${allDeals.length} deals carregados`);

  return allDeals.map(d => {
    const title = d.title || '';
    const numMatch = title.match(/\b(?:PE\s+SRP|SRP|TP|PP|PE|RDC|CV|DL|IL|OPEN)?\s*\d{1,4}[\/\-]\d{4}\b/i);
    const contractNum = numMatch ? numMatch[0].trim() : null;
    const emails = d.person_id?.email || [];
    const email = emails.find(e => e.value)?.value || '';
    const closingDate = d.expected_close_date || null;
    return {
      id: d.id,
      title,
      contractNum,
      clientName: contractNum ? title.replace(contractNum, '').trim() : title,
      personName: d.person_name || '',
      email,
      value: d.value || 0,
      currency: d.currency || 'BRL',
      closingDate,
      daysLeft: closingDate ? daysUntil(closingDate) : null,
      pipeline: d._pipe || '',
      url: `https://app.pipedrive.com/deal/${d.id}`,
    };
  });
}

// ── EMAILJS (server-side) ─────────────────────────────────────────────────────
async function sendEmail({ to_email, to_name, subject, message }) {
  const res = await httpPost('api.emailjs.com', '/api/v1.0/email/send', {
    service_id: CONFIG.emailjsServiceId,
    template_id: CONFIG.emailjsTemplateId,
    user_id: CONFIG.emailjsPublicKey,
    accessToken: CONFIG.emailjsPrivateKey,
    template_params: { to_email, to_name, subject, message }
  });
  if (res.status === 'OK' || res === 'OK') return true;
  if (res.raw === 'OK') return true;
  throw new Error(JSON.stringify(res));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏛️  LicitaControl — Notificação Automática Diária');
  console.log('━'.repeat(50));
  console.log(`📅 Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(`🔔 Alertar contratos com: ${CONFIG.alertDays.join(', ')} dias restantes`);
  console.log('━'.repeat(50));

  if (!CONFIG.pipedriveToken) { console.error('✗ PIPEDRIVE_TOKEN não configurado'); process.exit(1); }
  if (!CONFIG.emailjsServiceId) { console.error('✗ EMAILJS_SERVICE_ID não configurado'); process.exit(1); }

  const deals = await fetchDeals();

  // Filtrar deals que precisam de alerta hoje
  const toNotify = deals.filter(d => {
    if (d.daysLeft === null) return false;
    // Notifica se o número de dias restantes bate com algum dos alertDays configurados
    // OU se já venceu (daysLeft < 0) mas só nos primeiros 7 dias após vencimento
    if (d.daysLeft < 0 && d.daysLeft >= -7) return true;
    return CONFIG.alertDays.includes(d.daysLeft);
  });

  if (!toNotify.length) {
    console.log('\n✅ Nenhum contrato para notificar hoje.');
    return;
  }

  console.log(`\n📨 ${toNotify.length} contrato(s) para notificar:\n`);
  toNotify.forEach(d => {
    const status = d.daysLeft < 0 ? `VENCIDO há ${Math.abs(d.daysLeft)}d` : `Vence em ${d.daysLeft}d`;
    console.log(`  • ${d.contractNum || d.title} — ${status} — ${d.email || 'sem e-mail'}`);
  });

  let okCount = 0, errCount = 0, skipCount = 0;
  console.log('\n📤 Enviando e-mails...\n');

  for (const d of toNotify) {
    const ed = d.closingDate ? fmtDate(d.closingDate) : '—';
    const dias = d.daysLeft != null ? d.daysLeft : 0;
    const vars = { nome: d.clientName || d.title, contrato: d.contractNum || d.title, dias, data: ed, link: d.url };

    // E-mail para o CLIENTE
    if (d.email) {
      try {
        await sendEmail({
          to_email: d.email,
          to_name: d.personName || d.clientName,
          subject: replaceVars(CONFIG.subjCliente, vars),
          message: replaceVars(CONFIG.bodyCliente, vars),
        });
        console.log(`  ✓ CLIENTE — ${d.email} (${d.contractNum || d.title})`);
        okCount++;
        await sleep(500);
      } catch (e) {
        console.error(`  ✗ CLIENTE — ${d.email}: ${e.message}`);
        errCount++;
      }
    } else {
      console.log(`  ⏭ Sem e-mail — ${d.contractNum || d.title}`);
      skipCount++;
    }

    // E-mail para o TIME INTERNO
    for (const teamEmail of CONFIG.teamEmails) {
      try {
        await sendEmail({
          to_email: teamEmail,
          to_name: 'Time',
          subject: replaceVars(CONFIG.subjTime, vars),
          message: replaceVars(CONFIG.bodyTime, vars),
        });
        console.log(`  ✓ TIME — ${teamEmail} (${d.contractNum || d.title})`);
        okCount++;
        await sleep(500);
      } catch (e) {
        console.error(`  ✗ TIME — ${teamEmail}: ${e.message}`);
        errCount++;
      }
    }
  }

  console.log('\n' + '━'.repeat(50));
  console.log(`✅ Concluído: ${okCount} enviado(s), ${errCount} erro(s), ${skipCount} sem e-mail`);
  if (errCount > 0) process.exit(1);
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
