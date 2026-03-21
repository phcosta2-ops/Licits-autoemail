// ─────────────────────────────────────────────────────────────────────────────
// LicitaControl — Envio automático inteligente
// Regras clientes/time:
//   • Marcos: 30d, 15d, 5d antes + dia do vencimento + vencido (1x cada)
// Regra gerente:
//   • Toda SEGUNDA-FEIRA recebe um resumo semanal com todos os deals
//     que estão dentro de 30 dias de vencimento E não sofreram nenhuma
//     atualização no Pipedrive desde o primeiro e-mail enviado
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const LOG_FILE = path.join(__dirname, 'notifications-log.json');

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────
const CONFIG = {
  pipedriveToken:  process.env.PIPEDRIVE_TOKEN,
  ejServiceId:     process.env.EMAILJS_SERVICE_ID,
  ejTemplateId:    process.env.EMAILJS_TEMPLATE_ID,
  ejPublicKey:     process.env.EMAILJS_PUBLIC_KEY,
  ejPrivateKey:    process.env.EMAILJS_PRIVATE_KEY,
  teamEmails:      (process.env.TEAM_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean),
  managerEmail:    process.env.MANAGER_EMAIL || '',
  companyName:     process.env.COMPANY_NAME  || 'RC Scientific',

  // Nome da empresa por funil — chave é parte do nome do funil (minúsculo)
  companyByPipeline: {
    'rc scientific': 'RC Scientific',
    'line':          'Linecontrol',
  },

  // Marcos de disparo para clientes/time (dias antes do vencimento)
  alertDays: [30, 15, 5],

  // Textos — cliente
  subjCliente: process.env.SUBJ_CLIENTE || 'Seu contrato {CONTRATO} está prestes a vencer',
  // Textos por marco — 30d, 15d, 5d, 0d/expired
  bodyCliente30: `Prezado(a) {NOME},

O contrato {CONTRATO} com {EMPRESA} vence em {DATA} ({DIAS} dias). Há saldo disponível que precisa ser utilizado dentro deste prazo.

Verifique as ordens de fornecimento pendentes e entre em contato conosco para dar andamento.

Atenciosamente,
Equipe {EMPRESA}`,

  bodyCliente15: `Prezado(a) {NOME},

⚠️ O contrato {CONTRATO} com {EMPRESA} vence em {DATA} — restam apenas {DIAS} dias.

Ordens de fornecimento não emitidas até o vencimento resultarão em perda do saldo contratual. Entre em contato imediatamente para regularizar.

Atenciosamente,
Equipe {EMPRESA}`,

  bodyCliente5: `Prezado(a) {NOME},

🚨 URGENTE — O contrato {CONTRATO} vence em {DATA}. Restam {DIAS} dias.

Qualquer saldo não utilizado será perdido após essa data. Entre em contato hoje mesmo.

Atenciosamente,
Equipe {EMPRESA}`,

  bodyCliente0: `Prezado(a) {NOME},

🚨 URGENTE — O contrato {CONTRATO} venceu hoje ({DATA}).

Entre em contato imediatamente para verificar a situação das ordens de fornecimento.

Atenciosamente,
Equipe {EMPRESA}`,

  bodyCliente: process.env.BODY_CLIENTE || '',  // fallback vazio — usa os marcos acima

  // Textos — time interno
  subjTime: process.env.SUBJ_TIME || '[ALERTA] Contrato {CONTRATO} vence em {DIAS} dias',
  bodyTime: process.env.BODY_TIME ||
`Alerta de vencimento de contrato

Contrato : {CONTRATO}
Cliente  : {NOME}
Vencimento: {DATA}
Prazo    : {DIAS} dia(s)

Acesse o deal no Pipedrive:
{LINK_PIPEDRIVE}

— LicitaControl · {EMPRESA}`,
};

// ── LOG ───────────────────────────────────────────────────────────────────────
function loadLog() {
  try { if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch(e) { console.warn('⚠ Não foi possível ler o log:', e.message); }
  return {};
}
function saveLog(log) { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function today() { return new Date().toISOString().slice(0, 10); }
function isMonday() { return new Date().getDay() === 1; }

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function httpPost(hostname, pth, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname, path: pth, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ status: res.statusCode, raw: d }); }});
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// ── PIPEDRIVE ─────────────────────────────────────────────────────────────────
async function fetchDeals() {
  console.log('📡 Buscando pipelines...');
  const pr = await httpGet(`https://api.pipedrive.com/v1/pipelines?api_token=${CONFIG.pipedriveToken}`);
  const pipes = (pr.data || []).filter(p =>
    p.name.toLowerCase().includes('licitaç') || p.name.toLowerCase().includes('licitac')
  );
  console.log(pipes.length ? `✓ Funis: ${pipes.map(p => p.name).join(', ')}` : '⚠ Carregando todos os deals');

  let raw = [];
  const targets = pipes.length ? pipes : [{ id: null, name: 'Todos' }];
  for (const pipe of targets) {
    let start = 0;
    while (true) {
      let url = `https://api.pipedrive.com/v1/deals?api_token=${CONFIG.pipedriveToken}&status=open&limit=100&start=${start}`;
      if (pipe.id) url += `&pipeline_id=${pipe.id}`;
      const r = await httpGet(url);
      if (!r.success || !r.data) break;
      r.data.forEach(d => raw.push({ ...d, _pipe: pipe.name }));
      if (!r.additional_data?.pagination?.more_items_in_collection) break;
      start += 100;
    }
  }
  console.log(`✓ ${raw.length} deals carregados`);

  return raw.map(d => {
    const title = d.title || '';
    const numMatch = title.match(/\b(?:PE\s+SRP|SRP|TP|PP|PE|RDC|CV|DL|IL|OPEN)?\s*\d{1,4}[\/\-]\d{4}\b/i);
    const contractNum = numMatch ? numMatch[0].trim() : null;
    const closingDate = d.expected_close_date || null;
    return {
      id: d.id,
      title,
      contractNum,
      clientName: contractNum ? title.replace(contractNum, '').trim() : title,
      personName: d.person_name || '',
      email: (d.person_id?.email || []).find(e => e.value)?.value || '',
      closingDate,
      daysLeft: closingDate ? daysUntil(closingDate) : null,
      updateTime: d.update_time || null,
      url: `https://app.pipedrive.com/deal/${d.id}`,
      pipeline: d._pipe || '',
    };
  });
}

function daysUntil(ds) {
  const d = new Date(ds + 'T12:00:00'), n = new Date();
  n.setHours(0, 0, 0, 0);
  return Math.round((d - n) / 86400000);
}

function fmtDate(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// ── EMAIL ─────────────────────────────────────────────────────────────────────
function getBodyCliente(marco) {
  if (marco === '30') return CONFIG.bodyCliente30;
  if (marco === '15') return CONFIG.bodyCliente15;
  if (marco === '5')  return CONFIG.bodyCliente5;
  return CONFIG.bodyCliente0; // 0d ou expired
}

function getCompany(pipelineName) {
  const name = (pipelineName || '').toLowerCase();
  for (const [key, val] of Object.entries(CONFIG.companyByPipeline)) {
    if (name.includes(key)) return val;
  }
  return CONFIG.companyName; // fallback padrão
}

function replaceVars(tpl, v) {
  return tpl
    .replace(/{NOME}/g,      v.nome     || '')
    .replace(/{CONTRATO}/g,  v.contrato || '')
    .replace(/{DIAS}/g,      v.dias     != null ? String(v.dias) : '')
    .replace(/{DATA}/g,      v.data     || '')
    .replace(/{EMPRESA}/g,   v.empresa || CONFIG.companyName)
    .replace(/{LINK_PIPEDRIVE}/g, v.link || '');
}

async function sendEmail({ to, name, subject, message }) {
  const res = await httpPost('api.emailjs.com', '/api/v1.0/email/send', {
    service_id:      CONFIG.ejServiceId,
    template_id:     CONFIG.ejTemplateId,
    user_id:         CONFIG.ejPublicKey,
    accessToken:     CONFIG.ejPrivateKey,
    template_params: { to_email: to, to_name: name, subject, message },
  });
  if (res === 'OK' || res.status === 'OK' || res.raw === 'OK') return;
  throw new Error(JSON.stringify(res));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── RESUMO SEMANAL DO GERENTE ─────────────────────────────────────────────────
async function sendWeeklyManagerSummary(deals, log) {
  if (!CONFIG.managerEmail) {
    console.log('⏭ MANAGER_EMAIL não configurado — pulando resumo semanal');
    return;
  }

  // Deals dentro de 30 dias que já receberam notificação
  // e NÃO foram atualizados no Pipedrive desde então
  const semAcao = deals.filter(d => {
    if (d.daysLeft === null || d.daysLeft < 0 || d.daysLeft > 30) return false;
    const entry = log[`deal_${d.id}`];
    if (!entry || !entry.first_sent_at) return false; // ainda não notificado
    const foiAtualizado = d.updateTime !== entry.pd_update_at_first_send;
    return !foiAtualizado; // só inclui os sem atualização
  });

  console.log(`\n📊 Resumo semanal — ${semAcao.length} deal(s) sem ação dentro de 30 dias`);

  if (semAcao.length === 0) {
    // Mesmo sem deals problemáticos, manda um resumo positivo
    try {
      await sendEmail({
        to: CONFIG.managerEmail,
        name: 'Gerente',
        subject: `[Resumo Semanal] LicitaControl — Nenhum contrato parado 🟢`,
        message:
`Bom dia,

Resumo semanal de contratos — ${new Date().toLocaleDateString('pt-BR')}

✅ Todos os contratos dentro de 30 dias de vencimento estão com movimentação no Pipedrive.

Nenhuma ação necessária esta semana.

— LicitaControl · ${CONFIG.companyName}`,
      });
      console.log(`  ✓ Resumo positivo enviado → ${CONFIG.managerEmail}`);
    } catch(e) {
      console.error(`  ✗ Erro ao enviar resumo: ${e.message}`);
    }
    return;
  }

  // Monta tabela de texto com os deals problemáticos
  const linhas = semAcao
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map((d, i) => {
      const entry = log[`deal_${d.id}`];
      const primEnvio = entry?.first_sent_at || '—';
      const status = d.daysLeft === 0 ? 'VENCE HOJE'
        : d.daysLeft <= 5  ? `⚠ ${d.daysLeft} dias`
        : d.daysLeft <= 15 ? `🟡 ${d.daysLeft} dias`
        : `🟢 ${d.daysLeft} dias`;
      return `${i + 1}. ${d.contractNum || d.title}
   Cliente   : ${d.clientName || '—'}
   Vencimento: ${d.closingDate ? fmtDate(d.closingDate) : '—'} (${status})
   1º e-mail : ${primEnvio}
   Pipedrive : ${d.url}`;
    })
    .join('\n\n');

  const subject = `[Resumo Semanal] ${semAcao.length} contrato(s) sem resposta — ${new Date().toLocaleDateString('pt-BR')}`;
  const message =
`Bom dia,

Resumo semanal de contratos — ${new Date().toLocaleDateString('pt-BR')}

Os ${semAcao.length} contrato(s) abaixo estão dentro de 30 dias de vencimento e NÃO tiveram nenhuma atualização no Pipedrive desde o primeiro e-mail enviado ao cliente:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${linhas}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Por favor, verifique com os vendedores responsáveis.

— LicitaControl · ${CONFIG.companyName}`;

  try {
    await sendEmail({ to: CONFIG.managerEmail, name: 'Gerente', subject, message });
    console.log(`  ✓ Resumo semanal enviado → ${CONFIG.managerEmail}`);
  } catch(e) {
    console.error(`  ✗ Erro ao enviar resumo: ${e.message}`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🏛️  LicitaControl — Notificação Automática Diária');
  console.log('━'.repeat(52));
  console.log(`📅 ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
  console.log(`📆 É segunda-feira: ${isMonday() ? 'SIM — resumo gerente será enviado' : 'Não'}`);
  console.log('━'.repeat(52));

  if (!CONFIG.pipedriveToken) { console.error('✗ PIPEDRIVE_TOKEN ausente'); process.exit(1); }
  if (!CONFIG.ejServiceId)    { console.error('✗ EMAILJS_SERVICE_ID ausente'); process.exit(1); }

  const deals  = await fetchDeals();
  const log    = loadLog();
  const tdStr  = today();
  let sent = 0, skipped = 0, errors = 0;

  // ── Notificações de marco (clientes + time) ────────────────────────────────
  console.log('\n📨 Verificando marcos de notificação...');

  for (const d of deals) {
    if (d.daysLeft === null) continue;

    const key   = `deal_${d.id}`;
    const entry = log[key] || { sent: {}, first_sent_at: null, pd_update_at_first_send: null };
    const days  = d.daysLeft;
    const ed    = d.closingDate ? fmtDate(d.closingDate) : '—';
    const vars  = { nome: d.personName || d.clientName, contrato: d.contractNum || d.title, dias: days, data: ed, link: d.url, empresa: getCompany(d.pipeline) };

    // Determina marco de hoje
    let marco = null;
    if (days >= 0 && CONFIG.alertDays.includes(days)) marco = String(days);
    if (days === 0) marco = '0';
    if (days < 0 && days >= -7 && !entry.sent['expired']) marco = 'expired';

    if (!marco || entry.sent[marco]) continue; // já enviado ou não é dia de marco

    console.log(`\n📋 ${d.contractNum || d.title} — marco: ${marco === 'expired' ? 'vencido' : marco + 'd'}`);
    let marcoOk = false;

    // Cliente
    if (d.email) {
      try {
        await sendEmail({ to: d.email, name: d.personName || d.clientName,
          subject: replaceVars(CONFIG.subjCliente, vars),
          message: replaceVars(getBodyCliente(marco), vars) });
        console.log(`  ✓ CLIENTE → ${d.email}`);
        marcoOk = true; sent++;
      } catch(e) { console.error(`  ✗ CLIENTE → ${d.email}: ${e.message}`); errors++; }
      await sleep(500);
    } else {
      console.log(`  ⏭ Sem e-mail cliente`);
      skipped++; marcoOk = true;
    }

    // Time
    for (const te of CONFIG.teamEmails) {
      try {
        await sendEmail({ to: te, name: 'Time',
          subject: replaceVars(CONFIG.subjTime, vars),
          message: replaceVars(CONFIG.bodyTime, vars) });
        console.log(`  ✓ TIME → ${te}`);
        sent++;
      } catch(e) { console.error(`  ✗ TIME → ${te}: ${e.message}`); errors++; }
      await sleep(500);
    }

    // Grava marco no log
    if (marcoOk) {
      entry.sent[marco] = tdStr;
      if (!entry.first_sent_at) {
        entry.first_sent_at           = tdStr;
        entry.pd_update_at_first_send = d.updateTime;
      }
      log[key] = entry;
    }
  }

  // ── Resumo semanal do gerente (toda segunda-feira) ─────────────────────────
  if (isMonday()) {
    await sendWeeklyManagerSummary(deals, log);
  }

  saveLog(log);

  console.log('\n' + '━'.repeat(52));
  console.log(`✅ Concluído: ${sent} enviado(s), ${skipped} sem e-mail, ${errors} erro(s)`);
  if (errors > 0) process.exit(1);
}

main().catch(e => { console.error('Erro fatal:', e); process.exit(1); });
