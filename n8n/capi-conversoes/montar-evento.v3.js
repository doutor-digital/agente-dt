// ═══ MONTA O CORPO E DECIDE SE O EVENTO SAI (v3) ══════════════════════════════
// Ponto único de montagem: os dois caminhos (relógio e funil) convergem aqui.
//
// Três campos precisam andar JUNTOS para a Meta casar a conversão com o anúncio: action_source
// 'business_messaging', messaging_channel 'whatsapp' e o ctwa_clid dentro de user_data. Faltando um, o evento é
// aceito e não atribui nada. ctwa_clid, page_id e whatsapp_business_account_id vão CRUS (a Meta exige assim);
// todo dado pessoal vai em SHA-256.
//
// O que a v3 muda em relação à v2 (26/10/2026):
//  1. ANÚNCIO DE STATUS (sem ctwa_clid). Caminho oficial da Meta para mensagens sem clique: `page_id` +
//     `whatsapp_business_account_id` + pelo menos um dado de cliente em hash (aqui o `ph`, com 55). Sem `page_id` a
//     Meta REJEITA o evento mesmo com telefone válido. Só sai quando:
//       - a unidade tem cfg.status.pageId e cfg.status.modo diferente de 'desligado';
//       - existe um clique do cartão em ctwa_eventos (o "Buscar telefone e nome" achou pelo id do cartão) — é o que
//         prova que o lead veio de anúncio, e dá o telefone e a hora do clique;
//       - o evento é de até 7 dias depois do clique (depois disso a Meta aceita e NÃO atribui: não vale gastar).
//     Fora disso o descarte continua 'sem_ctwa_clid', como na v2, para as contagens não mudarem.
//  2. "Pediu horário" (via === 'pediu_horario'): só vale até 7 dias depois do clique, e o event_time nunca é
//     anterior ao clique.
//  3. `ph` sempre com DDI: o telefone vem do wa_id da conversa (já com 55). Medido em 30 dias: 99,9% dos
//     contatos têm 12-13 dígitos começando em 55; o resto é número estrangeiro. NÃO se chuta DDI em número de
//     fora — chutar 55 num número estrangeiro é marcar a pessoa errada.
const cfg = $('Config').first().json.cfg;
const nodeCrypto = (typeof crypto !== 'undefined' && crypto.createHmac) ? crypto : require('crypto');
const agora = Math.floor(Date.now() / 1000);
const DIA = 86400;
const JANELA = (Number(cfg.janelaDias) || 7) * DIA;   // a Meta recusa/ignora o que passa de 7 dias; Config sem o campo não pode abrir a janela
const sc = cfg.status || { modo: 'desligado' };

const sha = (v) => nodeCrypto.createHash('sha256').update(String(v)).digest('hex');

// minúsculas, sem pontuação, sem acento — "José da Silva" e "jose da silva" precisam gerar o mesmo hash
function limpaNome(v) {
  return String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Telefone: só dígitos, com DDI, sem zeros à esquerda (a Meta exige o código do país no `ph`).
function limpaTelefone(v) {
  const d = String(v || '').replace(/\D/g, '').replace(/^0+/, '');
  return d.length >= 10 ? d : null;
}

const saida = [];

for (const item of $input.all()) {
  const d = item.json;

  // Conversão de outro funil caindo neste dataset contamina a otimização das campanhas desta unidade.
  if (String(d.pipeline_id) !== cfg.pipelineId) {
    saida.push({ json: { ...d, _aprovado: false, motivo: 'unidade_fora_do_mapa' } });
    continue;
  }

  const cliqueEm = d.clique_em != null && d.clique_em !== '' ? Number(d.clique_em) : null;
  const semClid = !d.ctwa_clid;
  const telefone = limpaTelefone(d.telefone);
  let eventTime = Number(d.event_time);

  // Clique "no futuro" é dado quebrado (relógio, importação): não serve de prova de anúncio nem de janela.
  if (cliqueEm != null && cliqueEm > agora + 300) {
    saida.push({ json: { ...d, _aprovado: false, motivo: 'clique_no_futuro' } });
    continue;
  }

  // ── sem ctwa_clid: só o caminho de Status, e só se a unidade ligou ────────────────────────────────
  if (semClid) {
    const statusLigado = sc.modo && sc.modo !== 'desligado' && !!sc.pageId;
    if (!statusLigado || !d.clique_encontrado) {
      // Sem clique não há o que atribuir: lead de outra origem. É a razão entre descartes e envios.
      saida.push({ json: { ...d, _aprovado: false, motivo: 'sem_ctwa_clid' } });
      continue;
    }
    if (!telefone) {
      saida.push({ json: { ...d, _aprovado: false, motivo: 'status_sem_telefone' } });
      continue;
    }
    if (cliqueEm == null || eventTime - cliqueEm > JANELA) {
      saida.push({ json: { ...d, _aprovado: false, motivo: 'status_fora_7d_do_clique' } });
      continue;
    }
    if (eventTime < cliqueEm) eventTime = Math.min(cliqueEm, agora);   // o evento não pode ser anterior ao clique que o atribui (nem estar no futuro)
  }

  // ── "pediu horário": o Lead só conta até 7 dias depois do clique ─────────────────────────────────
  if (d.via === 'pediu_horario') {
    if (cliqueEm == null) {
      saida.push({ json: { ...d, _aprovado: false, motivo: 'pediu_sem_hora_do_clique' } });
      continue;
    }
    if (eventTime < cliqueEm) eventTime = Math.min(cliqueEm, agora);   // o pedido não pode ser anterior ao clique (nem estar no futuro)
    if (eventTime - cliqueEm > JANELA) {
      saida.push({ json: { ...d, _aprovado: false, motivo: 'pediu_fora_7d_do_clique' } });
      continue;
    }
  }

  // A Meta recusa event_time com mais de 7 dias (e derruba o lote inteiro se um passar disso).
  if (agora - eventTime > JANELA) {
    saida.push({ json: { ...d, _aprovado: false, motivo: 'fora_da_janela_7d' } });
    continue;
  }

  // ── user_data ────────────────────────────────────────────────────────────
  const user_data = semClid
    ? { page_id: String(sc.pageId), whatsapp_business_account_id: cfg.wabaId }
    : { ctwa_clid: d.ctwa_clid, whatsapp_business_account_id: cfg.wabaId };
  const sinais = [semClid ? 'page_id' : 'ctwa_clid'];

  if (telefone) {
    user_data.ph = sha(telefone);
    // external_id liga ViewContent/LeadSubmitted/Purchase da MESMA pessoa; no caminho sem clique a Meta diz que
    // ele "não é usado para casar" — vai igual, não atrapalha.
    user_data.external_id = sha(telefone);
    user_data.country = sha('br');
    sinais.push('ph', 'external_id', 'country');
  }

  const nome = limpaNome(d.nome);
  if (nome) {
    const partes = nome.split(' ');
    user_data.fn = sha(partes[0]);
    sinais.push('fn');
    if (partes.length > 1) {
      user_data.ln = sha(partes[partes.length - 1]);
      sinais.push('ln');
    }
  }

  const evento = {
    event_name: d.event_name,
    event_time: eventTime,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    event_id: d.event_id,
    user_data,
  };

  // Todo Purchase sai com o MESMO valor modelado — decisão do Gabriel em 31/08/2026 (o `price` da Kommo espelha a
  // consulta, não o tratamento; e sem `currency` a Meta recusa com o subcode 2804010).
  if (d.event_name === 'Purchase') {
    evento.custom_data = { currency: 'BRL', value: cfg.valorPurchase };
  }

  saida.push({ json: {
    ...d,
    event_time: eventTime,
    _aprovado: true,
    // modo seco do Status: roda tudo, grava 'simulado' e NÃO chama a Meta (o IF "Modo teste" lê _seco)
    _seco: d._seco === true || (semClid && sc.modo === 'seco'),
    unidade: cfg.unidade,
    destino: cfg.dataset,
    sinais: sinais.join(','),   // vai para o log: dá para medir a qualidade do match
    corpo: {
      data: [evento],
      ...(cfg.testEventCode ? { test_event_code: cfg.testEventCode } : {}),
    },
  }});
}

// O nó Code tem UMA saída só: devolver [aprovados, descartados] faz o n8n ler uma lista de listas e recusar tudo.
return saida;
