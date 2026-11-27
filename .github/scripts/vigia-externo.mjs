// Vigia externo do agente-dt. Roda no GitHub Actions (fora da VPS), a cada 10 min.
// Consulta GET /api/health/ia, decide com as regras de backend/src/lib/watchdog-decisao.ts (as mesmas testadas na suíte)
// e avisa o João por WhatsApp (Kapso) e Telegram. Nunca imprime URL, token, chave nem número: o repositório é PÚBLICO.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ESTADO_VAZIO, avancar, avisoDeTeste, observar, umaLinha } from '../../backend/src/lib/watchdog-decisao.ts';

const env = (k, padrao = '') => String(process.env[k] || padrao).trim(); // secret vazio no Actions chega como '', não como ausente
const ARQUIVO = env('ESTADO_ARQUIVO', 'estado/vigia.json');
const MODO_TESTE = ['1', 'true'].includes(env('MODO_TESTE').toLowerCase());

const log = (o) => console.log(JSON.stringify(o));

// ── 1. consulta a saúde (2 tentativas: um soluço de rede não é queda) ───────────────────────────────────────────────

async function consultar() {
  const url = env('HEALTH_URL');
  try {
    new URL(url);
  } catch {
    return { status: 404, corpo: null }; // segredo mal colado (sem https://): é o vigia que está cego, não o servidor que caiu
  }
  let ultimo = { status: null, corpo: null };
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const r = await fetch(url, { headers: { 'X-Health-Token': env('HEALTH_IA_TOKEN'), Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      const texto = await r.text();
      let corpo = null;
      try {
        corpo = JSON.parse(texto);
      } catch {
        corpo = null;
      }
      ultimo = { status: r.status, corpo };
      if (r.status < 500 && r.status !== 429) return ultimo;
    } catch {
      ultimo = { status: null, corpo: null };
    }
    if (tentativa < 2) await new Promise((res) => setTimeout(res, Number(env('ESPERA_ENTRE_TENTATIVAS_MS', '8000'))));
  }
  return ultimo;
}

// ── 2. canais de aviso (independentes entre si; basta um chegar) ────────────────────────────────────────────────────

async function postar(url, cabecalhos, corpo) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(20_000) });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, codigo: j?.error?.code ?? j?.error_code ?? null };
}

/** WhatsApp pelo Kapso. Modelo aprovado primeiro (vale a qualquer hora); texto livre só como segunda tentativa (a Meta só aceita dentro de 24 h da última mensagem do João). */
async function enviarKapso(texto) {
  const chave = env('KAPSO_API_KEY');
  const numeroId = env('KAPSO_PHONE_NUMBER_ID');
  const para = env('ALERTA_WHATSAPP_NUMERO').replace(/\D/g, '');
  if (!chave || !numeroId || !para) return { canal: 'whatsapp', configurado: false, ok: false };
  if (!/^\d{10,15}$/.test(para)) return { canal: 'whatsapp', configurado: true, ok: false, motivo: 'número inválido' };
  const url = `${env('KAPSO_BASE', 'https://api.kapso.ai/meta/whatsapp/v24.0').replace(/\/+$/, '')}/${encodeURIComponent(numeroId)}/messages`;
  const cab = { 'X-API-Key': chave };
  let modelo = { ok: false, status: 0, codigo: null };
  try {
    modelo = await postar(url, cab, {
      messaging_product: 'whatsapp',
      to: para,
      type: 'template',
      template: { name: env('KAPSO_TEMPLATE', 'alerta_sistema'), language: { code: env('KAPSO_TEMPLATE_IDIOMA', 'pt_BR') }, components: [{ type: 'body', parameters: [{ type: 'text', text: umaLinha(texto, 900) }] }] },
    });
  } catch {
    // o modelo estourou o prazo ou a rede falhou: ainda vale tentar o texto livre abaixo
  }
  try {
    if (modelo.ok) return { canal: 'whatsapp', configurado: true, ok: true, via: 'modelo' };
    const livre = await postar(url, cab, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } });
    return { canal: 'whatsapp', configurado: true, ok: livre.ok, via: livre.ok ? 'texto livre' : undefined, statusModelo: modelo.status, codigoModelo: modelo.codigo, statusTexto: livre.status };
  } catch (err) {
    return { canal: 'whatsapp', configurado: true, ok: false, motivo: String(err?.name ?? 'erro') };
  }
}

async function enviarTelegram(texto) {
  const token = env('TELEGRAM_BOT_TOKEN');
  const chat = env('TELEGRAM_CHAT_ID');
  if (!token || !chat) return { canal: 'telegram', configurado: false, ok: false };
  try {
    const r = await postar(`${env('TELEGRAM_API', 'https://api.telegram.org').replace(/\/+$/, '')}/bot${token}/sendMessage`, {}, { chat_id: chat, text: texto, disable_web_page_preview: true });
    return { canal: 'telegram', configurado: true, ok: r.ok, status: r.status };
  } catch (err) {
    return { canal: 'telegram', configurado: true, ok: false, motivo: String(err?.name ?? 'erro') };
  }
}

async function avisar(texto) {
  const r = await Promise.all([enviarKapso(texto), enviarTelegram(texto)]);
  for (const c of r) log({ canal: c.canal, configurado: c.configurado, ok: c.ok, via: c.via, status: c.status ?? c.statusModelo, codigo: c.codigoModelo, motivo: c.motivo });
  return r.some((c) => c.ok);
}

// ── 3. estado entre rodadas (cache do Actions) ──────────────────────────────────────────────────────────────────────

function lerEstado() {
  try {
    return existsSync(ARQUIVO) ? JSON.parse(readFileSync(ARQUIVO, 'utf8')) : null;
  } catch {
    console.log('::warning::o estado do vigia existe mas não pôde ser lido: recomeçando do zero (um incidente aberto pode ser reanunciado)');
    return null;
  }
}
function gravarEstado(e) {
  mkdirSync(dirname(ARQUIVO), { recursive: true });
  writeFileSync(ARQUIVO, JSON.stringify(e));
}

// ── 4. a rodada ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (MODO_TESTE) {
    const chegou = await avisar(avisoDeTeste(env('MOTIVO_DO_TESTE', 'manual')).texto);
    log({ teste: true, entregue: chegou });
    return chegou ? 0 : 1;
  }

  if (!env('HEALTH_URL')) {
    // Segredo ainda não cadastrado: sair VERDE com aviso. Vermelho aqui seria ~144 e-mails de «falhou» por dia até alguém cadastrar.
    console.log('::warning::HEALTH_URL não está cadastrado nos segredos do GitHub: o vigia externo está DESLIGADO (docs/vigia-externo.md)');
    log({ vigia: 'desligado', motivo: 'HEALTH_URL ausente' });
    return 0;
  }
  const resposta = await consultar();
  const obs = observar(resposta);
  const anterior = lerEstado();
  const { avisos, estado } = avancar(anterior ?? ESTADO_VAZIO, obs, Date.now());
  log({ observado: obs.tipo, causa: obs.causa, avisos: avisos.map((a) => a.tipo) });

  let entregue = true;
  for (const a of avisos) {
    if (!(await avisar(a.texto))) entregue = false;
  }

  if (entregue) {
    gravarEstado(estado);
    return 0;
  }
  // Não chegou por canal nenhum: NÃO gasta o throttle (a próxima rodada tenta de novo) e deixa a rodada VERMELHA, que o
  // GitHub avisa por e-mail: o último recurso de quem não sabe que o alerta não está saindo.
  const voltou = avisos.some((a) => a.tipo === 'voltou');
  gravarEstado(voltou ? (anterior ?? ESTADO_VAZIO) : { ...estado, ultimoAviso: anterior?.ultimoAviso ?? {} });
  log({ erro: 'nenhum canal entregou o aviso', configure: 'KAPSO_API_KEY + KAPSO_PHONE_NUMBER_ID + ALERTA_WHATSAPP_NUMERO e/ou TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID' });
  return 1;
}

process.exitCode = await main();
