# frozen_string_literal: true

# IMPORTA O HISTÓRICO do Instagram Direct (caixa Channel::Instagram) e do Messenger (Channel::FacebookPage) para o CRM (Chatwoot).
# Roda DENTRO do contêiner `chatwoot_rails`:  bundle exec rails runner importar-historico-social.rb   (quem chama é o
# ops/historico-social-crm-joao.sh). Dado de paciente não sai do servidor. Só ids e contagens vão para a saída — nunca nome, @usuário,
# telefone, texto ou token.
#
# SEGURANÇA — «nada pode reagir à importação»: tudo é gravado com insert_all!/update_all/update_columns, que NÃO passam pelos callbacks do
# Rails. Os eventos do Chatwoot (webhooks para o nosso agente, automações nativas, notificações/e-mail, ActionCable, jobs do Sidekiq) nascem
# nos callbacks `after_*_commit` dos modelos (Message, Conversation, Contact); sem callback, não nascem. O mesmo método da importação do
# WhatsApp (hist_fase_b.rb / unificar-historico.rb). A prova está em testar-silencio.sh (roda isto numa instalação descartável com
# webhook + automações ligados e conta eventos/jobs: tem de dar zero; e o controle positivo, a criação normal, tem de dar mais que zero).
#
# Variáveis (todas opcionais):
#   GRAVAR=1            sem isto é CONFERÊNCIA EM SECO: só lê (Meta e banco) e conta. NADA é escrito.
#   CAIXAS=7,8          ids das caixas (padrão 7 e 8)
#   LIMITE_CONVERSAS=n  só as n primeiras conversas de cada caixa (teste pequeno antes do lote)
#   CORTE=ISO8601       mensagens a partir desta hora NÃO são importadas (são «vivas»: o webhook entrega). Padrão: a hora em que CADA CAIXA foi
#                       criada (inboxes.created_at) — webhook atrasado da Meta repete por horas. Só vale se não passar de início − 15 min.
#   RITMO=0.7           segundos entre chamadas à Meta (a API de conversas aguenta ~2/s)
#   FIXTURES=arquivo    (teste) lê as conversas de um JSON em vez da Meta
#   MIDIA=0             não baixa mídia (padrão: baixa e anexa imagem, figurinha, áudio, vídeo e arquivo NA HORA, enquanto a URL da Meta vale)
#   MIDIA_MAX_MB=25     teto por arquivo     MIDIA_PRAZO=60  segundos por download     MIDIA_TOTAL_MB=2048  teto da rodada
#   MIDIA_MIN_LIVRE_MB=3000  para de baixar se o disco do armazenamento tiver menos livre que isto
#   MODO=desfazer       com REGISTRO=arquivo.jsonl (linhas REG de uma rodada): desfaz o que aquela rodada criou (seco sem GRAVAR=1)
require 'json'
require 'securerandom'
require 'set'
require 'shellwords'
require 'erb'
require File.join(ENV['HS_DIR'] || File.dirname(File.expand_path(__FILE__)), 'historico_social')

S = HistoricoSocial unless defined?(S)
# STDOUT (e não $stdout): sob `rails runner` o $stdout é bufferizado e o acompanhamento só veria o log no fim da rodada
STDOUT.sync = true

GRAVAR = ENV['GRAVAR'] == '1'
CAIXAS = (ENV['CAIXAS'] || '7,8').split(',').map { |x| x.strip.to_i }.reject(&:zero?)
ERROS_DE_PARAMETRO = [] # explicados na 1ª linha de erro (antes de qualquer coisa ser lida ou gravada)
LIMITE = begin
  if ENV['LIMITE_CONVERSAS'].to_s.empty?
    0
  else
    n = Integer(ENV['LIMITE_CONVERSAS'], 10)
    ERROS_DE_PARAMETRO << 'LIMITE_CONVERSAS=0 (ou negativo) é recusado: 0 não significa «sem limite» — tire a variável para importar tudo' if n <= 0
    n
  end
rescue ArgumentError
  ERROS_DE_PARAMETRO << 'LIMITE_CONVERSAS precisa ser um número inteiro'
  0
end
RITMO = (ENV['RITMO'] || '0.7').to_f
INICIO = Time.now.utc
CORTE_INFORMADO = begin
  ENV['CORTE'].to_s.empty? ? nil : Time.iso8601(ENV['CORTE']).utc
rescue ArgumentError
  ERROS_DE_PARAMETRO << 'CORTE inválido (use AAAA-MM-DDTHH:MM:SSZ)'
  nil
end
DESDE_14_11 = Time.utc(2026, 11, 14, 3, 0, 0) # 14/11 00:00 em Belém: o corte do «arquivo» das telas do agente (chatwoot-regua.ts)
RECENTE_72H = INICIO - (72 * 3600)
FIXTURES = ENV['FIXTURES'].to_s.empty? ? nil : ENV['FIXTURES']
MIDIA_ATIVA = ENV['MIDIA'] != '0'
MIDIA_MAX_BYTES = ((ENV['MIDIA_MAX_MB'] || '25').to_f * 1_048_576).to_i
MIDIA_PRAZO = (ENV['MIDIA_PRAZO'] || '60').to_i
MIDIA_TOTAL_BYTES = ((ENV['MIDIA_TOTAL_MB'] || '2048').to_f * 1_048_576).to_i
MIDIA_MIN_LIVRE_MB = (ENV['MIDIA_MIN_LIVRE_MB'] || '3000').to_f
$midia_bytes = 0
$midia_baixadas = 0

def log(texto)
  STDOUT.puts "LOG #{Time.now.utc.strftime('%H:%M:%S')} #{texto}"
  STDOUT.flush
end

# Registro para desfazer: só ids. Linha `REG {...}` (o ops/*.sh guarda a saída em /root/kit/logs).
def reg(tipo, caixa, ids)
  ids.each_slice(2000) { |s| STDOUT.puts "REG #{{ tipo: tipo, caixa: caixa, ids: s }.to_json}" } unless ids.empty?
end

# Erro NOSSO, com texto fixo (sem dado de paciente): a mensagem é impressa para o João saber o que consertar.
class ErroNosso < StandardError; end

# Erro sem texto de paciente: o PG imprime a LINHA inteira num NOT NULL; então só classe e SQLSTATE.
def erro_seguro(e)
  causa = e.respond_to?(:cause) ? e.cause : nil
  estado = causa.respond_to?(:result) && causa.result ? causa.result.error_field(PG::PG_DIAG_SQLSTATE) : nil
  base = e.is_a?(S::ErroDaMeta) || e.is_a?(S::Parar) || e.is_a?(ErroNosso) ? e.message : e.class.name
  [base, causa && causa.class.name, estado && "sqlstate #{estado}"].compact.join(' / ')
end

def zerar
  Hash.new(0)
end

# ─── desfazer ───────────────────────────────────────────────────────────────────────────────────────────────────────
def desfazer!
  arq = ENV['REGISTRO'].to_s
  raise ErroNosso, 'MODO=desfazer exige REGISTRO=arquivo' if arq.empty? || !File.file?(arq)

  tudo = Hash.new { |h, k| h[k] = [] }
  File.foreach(arq) do |l|
    next unless l.start_with?('REG ')

    j = JSON.parse(l.sub('REG ', ''))
    tudo[j['tipo']].concat(j['ids']) if j['ids']
  end
  convs = tudo['conversas'].uniq
  mensagens_registro = tudo['mensagens'].uniq
  # conversa CRIADA pela rodada só sai inteira se NINGUÉM mais escreveu nela depois (mensagem fora do registro = a equipe/paciente já usou)
  # (e que continua como foi criada: resolvida, sem responsável, só com a etiqueta historico — etiqueta/atribuição da equipe = mexeram nela)
  intocadas = convs.select do |c|
    cv = Conversation.find_by(id: c)
    cv && cv.status == 'resolved' && cv.assignee_id.nil? && cv.cached_label_list.to_s == S::ETIQUETA &&
      Message.where(conversation_id: c).where.not(id: mensagens_registro).none?
  end
  mexidas = convs - intocadas
  # mensagens que a rodada acrescentou a uma conversa de histórico que JÁ existia (2ª rodada em diante): saem só elas, a conversa fica
  acrescimos = Message.where(id: mensagens_registro).where.not(conversation_id: convs)
                      .where(conversation_id: Conversation.where('COALESCE(jsonb_exists(additional_attributes, ?), false)', S::MARCA_CONVERSA).select(:id)).pluck(:id)
  log "desfazer: conversas criadas=#{convs.size} (intocadas=#{intocadas.size}; as #{mexidas.size} que a equipe já usou — mensagem, etiqueta ou responsável — ficam) " \
      "mensagens do registro=#{mensagens_registro.size} (acréscimos em conversa antiga=#{acrescimos.size}) " \
      "contatos=#{tudo['contatos'].uniq.size} contact_inboxes=#{tudo['contact_inboxes'].uniq.size}"
  anexos = tudo['anexos'].uniq
  armazenamento = tudo['armazenamento'].uniq
  blobs = tudo['blobs'].uniq
  msgs_com_anexo = Attachment.where(id: anexos).distinct.pluck(:message_id)
  log "desfazer mídia: anexos=#{anexos.size} blobs=#{blobs.size} (#{ActiveStorage::Blob.where(id: blobs).sum(:byte_size) / 1_048_576} MB) em #{msgs_com_anexo.size} mensagens"
  unless GRAVAR
    log 'SECO: nada foi apagado. Rode com GRAVAR=1 (e --confirmo-apagar) para desfazer.'
    return
  end
  ActiveRecord::Base.transaction do
    # 1º a mídia (anexos e vínculos com o arquivo) e o texto volta com os rótulos («[imagem]») nas mensagens que continuam existindo
    ActiveStorage::Attachment.where(id: armazenamento, record_type: 'Attachment').delete_all
    Attachment.where(id: anexos).delete_all
    restauradas = 0
    Message.where(id: msgs_com_anexo).where('COALESCE(jsonb_exists(additional_attributes, ?), false)', 'hist_conteudo_original').find_each do |m|
      original = m.additional_attributes['hist_conteudo_original']
      Message.where(id: m.id).update_all(['content = ?, processed_message_content = ?, additional_attributes = additional_attributes - ?::text', original, original, 'hist_conteudo_original'])
      restauradas += 1
    end
    log "desfeito: anexos=#{anexos.size} textos_restaurados=#{restauradas}"
    msgs = Message.where(conversation_id: intocadas, id: mensagens_registro).delete_all + Message.where(id: acrescimos).delete_all
    tags = ActsAsTaggableOn::Tagging.where(id: tudo['taggings'].uniq, taggable_type: 'Conversation', taggable_id: intocadas).delete_all
    cs = Conversation.where(id: intocadas).delete_all
    # contato/contact_inbox criados pela rodada só saem se não ficou nenhuma conversa ou mensagem presa a eles
    cis = tudo['contact_inboxes'].uniq.select { |ci| !Conversation.where(contact_inbox_id: ci).exists? }
    ContactInbox.where(id: cis).delete_all
    cts = tudo['contatos'].uniq.select { |c| !ContactInbox.where(contact_id: c).exists? && !Conversation.where(contact_id: c).exists? }
    Contact.where(id: cts).delete_all
    # nomes corrigidos (REG 'nomes') NÃO voltam a «John Doe» (o nome certo fica); datas de conversa antiga que recebeu acréscimo não são recuadas
    log "desfeito: mensagens=#{msgs} taggings=#{tags} conversas=#{cs} contact_inboxes=#{cis.size} contatos=#{cts.size}"
  end
  # o arquivo em disco só sai depois que o banco confirmou (não dá para voltar atrás de um arquivo apagado)
  purgados = 0
  ActiveStorage::Blob.where(id: blobs).find_each do |b|
    b.purge
    purgados += 1
  rescue StandardError => e
    log "não consegui apagar um blob (#{erro_seguro(e)})"
  end
  log "desfeito: blobs/arquivos=#{purgados}"
end

# ─── importação ─────────────────────────────────────────────────────────────────────────────────────────────────────
def fonte_da_caixa(inbox)
  canal = case inbox.channel_type
          when 'Channel::Instagram' then :instagram
          when 'Channel::FacebookPage' then :messenger
          else raise ErroNosso, "a caixa #{inbox.id} não é Instagram nem Messenger (#{inbox.channel_type})"
          end
  ch = inbox.channel
  lado = canal == :instagram ? ch.instagram_id : ch.page_id
  if FIXTURES
    return [canal, S::FonteFixture.new(JSON.parse(File.read(FIXTURES)).fetch(canal.to_s), lado_pagina: lado)]
  end

  # `ch[:access_token]` (e não `ch.access_token`): este último pode RENOVAR o token do Instagram e gravar no canal; a conferência não escreve.
  token = canal == :instagram ? ch[:access_token] : ch.page_access_token
  raise ErroNosso, "a caixa #{inbox.id} está sem token válido" if token.to_s.empty? || (canal == :instagram && ch.expires_at && ch.expires_at < Time.now.utc)

  base = canal == :instagram ? "https://graph.instagram.com/#{GlobalConfigService.load('INSTAGRAM_API_VERSION', 'v22.0')}" : 'https://graph.facebook.com/v22.0'
  [canal, S::FonteMeta.new(canal: canal, graph: S::Graph.new(base: base, token: token, ritmo: RITMO), lado_pagina: lado)]
end

# contato já existente desta pessoa nesta caixa (ou, no Instagram, o que veio pelo Messenger com o mesmo id — igual ao Chatwoot)
def achar_contato(inbox, canal, externo_id)
  ci = ContactInbox.find_by(inbox_id: inbox.id, source_id: externo_id)
  return [ci.contact_id, ci.id, :reaproveitado] if ci

  if canal == :instagram
    outro = ContactInbox.joins(:inbox).where(source_id: externo_id, inboxes: { channel_type: 'Channel::FacebookPage', account_id: inbox.account_id }).first
    return [outro.contact_id, nil, :reaproveitado_do_messenger] if outro
  end
  [nil, nil, :novo]
end

def nome_do_contato(canal, externo, perfil)
  id, nome_part, usuario = externo
  nome = nome_part
  nome = perfil['name'] if nome.to_s.empty? && perfil
  nome = (perfil && perfil['username']).to_s if nome.to_s.empty?
  nome = usuario if nome.to_s.empty?
  nome = canal == :instagram ? "Unknown (IG: #{id})" : S::NOME_PADRAO if nome.to_s.empty?
  [nome, usuario.to_s.empty? && perfil ? perfil['username'].to_s : usuario.to_s]
end

# ─── mídia ─────────────────────────────────────────────────────────────────────────────────────────────────────────
# Baixa NA HORA (a URL da Meta acabou de ser gerada) e anexa como Attachment do Chatwoot com `file` no ActiveStorage. Sem callbacks: o blob é
# criado com `create_and_upload!` e os dois vínculos (attachments e active_storage_attachments) com insert_all! — nada de `file.attach`, que
# enfileira análise/espelhamento, e nada de Attachment.create, que dispara transcrição de áudio e eventos. Falhou = fica o rótulo
# («[imagem]») e a falha entra na contagem; a rodada NUNCA para por causa de mídia.
def baixador
  $baixador ||= S::Baixador.new(max_bytes: MIDIA_MAX_BYTES, prazo: MIDIA_PRAZO, permitir: FIXTURES ? ->(u) { u.host == '127.0.0.1' } : nil)
end

def sufixo_do_host(url)
  h = URI.parse(url.to_s).host.to_s.split('.')
  h.last(2).join('.')
rescue URI::Error
  'invalido'
end

def espaco_livre_mb
  raiz = ActiveStorage::Blob.service.respond_to?(:root) ? ActiveStorage::Blob.service.root.to_s : nil
  return nil if raiz.to_s.empty?

  kb = `df -Pk #{Shellwords.escape(raiz)} 2>/dev/null`.lines.last.to_s.split[3].to_i
  kb.positive? ? kb / 1024.0 : nil
rescue StandardError
  nil
end

# SECO: só conta o que SERIA baixado (por tipo) e estima o tamanho (o da Graph, ou o Content-Length de um HEAD — nada é baixado).
def contar_midias_seco(midias, c)
  midias.each do |m|
    if m[:url].nil?
      c[:midias_sem_url] += 1
      next
    end
    unless baixador.host_permitido?(URI.parse(m[:url]))
      c[:midias_host_nao_permitido] += 1
      next
    end
    c[:"midias_a_baixar_#{m[:tipo]}"] += 1
    c[:"midias_host_#{sufixo_do_host(m[:url])}"] += 1
    bytes = m[:tamanho]
    unless bytes
      sleep 0.05
      bytes = baixador.medir(m[:url])
    end
    if bytes
      c[:midias_bytes_estimados] += bytes
      c[:midias_acima_do_teto] += 1 if bytes > MIDIA_MAX_BYTES
    else
      c[:midias_sem_tamanho] += 1
    end
  end
rescue URI::Error
  c[:midias_host_nao_permitido] += 1
end

# GRAVANDO: baixa as mídias de `idxs` da mensagem `n`; devolve [{ idx:, blob:, tipo_cw:, ext: }] só das que deram certo.
def baixar_midias(inbox, n, idxs, c)
  prontos = []
  n[:midias].select { |m| idxs.include?(m[:idx]) }.each do |m|
    if m[:url].nil?
      c[:midias_sem_url] += 1
      next
    end
    if $midia_bytes >= MIDIA_TOTAL_BYTES
      c[:midias_teto_da_rodada] += 1
      next
    end
    if ($midia_baixadas % 25).zero? && (livre = espaco_livre_mb) && livre < MIDIA_MIN_LIVRE_MB
      c[:midias_pouco_espaco_em_disco] += 1
      $midia_bytes = MIDIA_TOTAL_BYTES # para de baixar; o rótulo fica e a próxima rodada completa
      next
    end
    $midia_baixadas += 1
    begin
      r = baixador.baixar(m[:url], tipo: m[:tipo], mime_graph: m[:mime])
      begin
        nome = S.nome_do_arquivo(m[:nome], r[:content_type], m[:tipo], m[:idx])
        blob = ActiveStorage::Blob.create_and_upload!(io: r[:arquivo], filename: nome, content_type: r[:content_type], identify: false)
      ensure
        r[:arquivo].close!
      end
      reg('blobs', inbox.id, [blob.id]) # antes do commit: se a rodada cair agora, o arquivo já está no registro para desfazer
      $midia_bytes += r[:bytes]
      c[:"midias_baixadas_#{m[:tipo]}"] += 1
      c[:midias_bytes_gravados] += r[:bytes]
      prontos << { idx: m[:idx], blob: blob, tipo_cw: S.tipo_do_chatwoot(r[:content_type], m[:tipo]), ext: File.extname(nome).delete('.') }
    rescue S::ErroMidia => e
      c[:"midias_falha_#{e.motivo}"] += 1
    rescue StandardError => e
      c[:midias_falha_gravacao] += 1
      log "caixa #{inbox.id}: mídia não gravada (#{erro_seguro(e)})"
    end
  end
  prontos
end

def descartar_blobs(prontos)
  prontos.each do |p|
    p[:blob].purge
  rescue StandardError
    nil
  end
end

# O Chatwoot, para mensagem RECEBIDA numa caixa do Instagram, mostra a mídia pelo `external_url` do anexo (Attachment#instagram_incoming_message?) e
# não pelo arquivo guardado. Então o external_url recebe o link PERMANENTE do nosso arquivo (id assinado, não vence), nunca o da Meta.
def url_permanente(blob)
  base = (ENV['FRONTEND_URL'].presence || 'http://localhost:3000').chomp('/')
  "#{base}/rails/active_storage/blobs/redirect/#{blob.signed_id}/#{ERB::Util.url_encode(blob.filename.to_s)}"
end

# Dentro da transação: Attachment + vínculo com o blob, sem callbacks. `meta_parte` = que parte da mensagem é (para completar depois).
def gravar_anexos!(account_id, message_id, prontos, quando, ids)
  prontos.each do |p|
    att = Attachment.insert_all!([{ account_id: account_id, message_id: message_id, file_type: Attachment.file_types.fetch(p[:tipo_cw].to_s), extension: p[:ext].presence, external_url: url_permanente(p[:blob]),
                                    meta: { 'meta_parte' => p[:idx] }, created_at: quando, updated_at: quando }], returning: %w[id]).rows.first.first
    vinculo = ActiveStorage::Attachment.insert_all!([{ name: 'file', record_type: 'Attachment', record_id: att, blob_id: p[:blob].id, created_at: quando }],
                                                    returning: %w[id]).rows.first.first
    ids[:anexos] << att
    ids[:armazenamento] << vinculo
    ids[:blobs] << p[:blob].id
  end
end

# Mensagens JÁ importadas (conversa de histórico) a que ainda faltam mídias: [{ n:, id:, adicional:, anexadas: Set, faltam: [idx] }].
def midias_a_completar(inbox, normais)
  com_midia = normais.select { |n| n[:midias].any? { |m| m[:url] } }
  return [] if com_midia.empty?

  linhas = Message.joins(:conversation).where(inbox_id: inbox.id, source_id: com_midia.map { |n| n[:mid] })
                  .where('COALESCE(jsonb_exists(conversations.additional_attributes, ?), false)', S::MARCA_CONVERSA)
                  .pluck(:source_id, :id, :additional_attributes).to_h { |sid, id, ad| [sid, [id, ad || {}]] }
  return [] if linhas.empty?

  ja = Hash.new { |h, k| h[k] = Set.new }
  Attachment.where(message_id: linhas.values.map(&:first)).pluck(:message_id, Arel.sql("meta->>'meta_parte'")).each { |mid, parte| ja[mid] << parte.to_i unless parte.nil? }
  com_midia.filter_map do |n|
    id, ad = linhas[n[:mid]]
    next unless id

    faltam = n[:midias].reject { |m| ja[id].include?(m[:idx]) }.select { |m| m[:url] }.map { |m| m[:idx] }
    faltam.empty? ? nil : { n: n, id: id, adicional: ad, anexadas: ja[id], faltam: faltam }
  end
end

def completar_midias!(inbox, item, c)
  n = item[:n]
  prontos = baixar_midias(inbox, n, item[:faltam], c)
  return if prontos.empty?

  ids = { anexos: [], armazenamento: [], blobs: [] }
  conteudo = S.compor(n[:partes], item[:anexadas].to_a + prontos.map { |p| p[:idx] })
  begin
    ActiveRecord::Base.transaction do
      gravar_anexos!(inbox.account_id, item[:id], prontos, n[:ts], ids)
      ad = item[:adicional].key?('hist_conteudo_original') ? {} : { 'hist_conteudo_original' => S.compor(n[:partes], item[:anexadas].to_a) }
      Message.where(id: item[:id]).update_all(['content = ?, processed_message_content = ?, additional_attributes = COALESCE(additional_attributes, ?::jsonb) || ?::jsonb',
                                               conteudo, conteudo, '{}', ad.to_json])
    end
  rescue StandardError
    descartar_blobs(prontos)
    raise
  end
  c[:mensagens_completadas_com_midia] += 1
  ids.each { |tipo, lista| reg(tipo.to_s, inbox.id, lista.uniq) }
end

def importar_caixa!(inbox, tag, resumo)
  corte = begin
    S.resolver_corte(informado: CORTE_INFORMADO, criacao_da_caixa: inbox.created_at, inicio: INICIO)
  rescue ArgumentError => e
    raise ErroNosso, e.message
  end
  c = nil
  fonte = nil
  tipos = Hash.new(0)
  canal, fonte = fonte_da_caixa(inbox)
  c = resumo[inbox.id] = zerar
  seguidos = 0 # erros seguidos (qualquer conversa bem-sucedida zera): muitos seguidos = algo quebrado, para a rodada
  log "caixa #{inbox.id} (#{canal}): lendo conversas da Meta#{LIMITE.positive? ? " (limite #{LIMITE})" : ''}; corte #{corte.iso8601}"

  fonte.conversas(limite: LIMITE.positive? ? LIMITE : nil) do |conv|
    c[:conversas_meta] += 1
    log "caixa #{inbox.id}: #{c[:conversas_meta]} conversas lidas" if (c[:conversas_meta] % 100).zero?
    begin
      externo = fonte.participante_externo_de(conv)
      unless externo
        c[:conversas_sem_participante] += 1
        next
      end
      externo_id = externo[0]
      brutas, truncada = fonte.mensagens(conv['id'])
      c[:conversas_possivelmente_truncadas] += 1 if truncada
      c[:mensagens_meta] += brutas.size

      normais = []
      brutas.each do |m|
        n, motivo = S.normalizar(m, lado_pagina: fonte.lado_pagina)
        if n
          normais << n
          n[:tipos].each { |t| tipos[t] += 1 }
          c[n[:entrada] ? :mensagens_recebidas : :mensagens_enviadas] += 1
        else
          c["mensagens_puladas_#{motivo}".to_sym] += 1
        end
      end
      normais = S.ordenar_antigas_primeiro(normais)

      contato_id, ci_id, situacao = achar_contato(inbox, canal, externo_id)

      # nome do Messenger: troca só «John Doe»/vazio, e mesmo que a conversa não tenha mensagem nova
      if canal == :messenger && contato_id && !externo[1].to_s.empty?
        atual = Contact.where(id: contato_id).pick(:name)
        if S.nome_padrao?(atual) && externo[1] != S::NOME_PADRAO
          c[:nomes_a_corrigir] += 1
          if GRAVAR && Contact.where(id: contato_id).where(S.sql_nome_padrao('name')).update_all(name: externo[1]).positive?
            c[:nomes_corrigidos] += 1
            reg('nomes', inbox.id, [contato_id])
          end
        end
      end

      existentes = Message.where(inbox_id: inbox.id, source_id: normais.map { |m| m[:mid] }).pluck(:source_id).to_set
      sep = S.separar(normais, existentes: existentes, corte: corte)
      c[:mensagens_ja_existiam] += sep[:ja_existiam]
      c[:mensagens_pos_corte_nao_importadas] += sep[:pos_corte]
      novas = sep[:novas]
      # mensagens que já estão no CRM (de uma rodada anterior, p.ex. o piloto) e ainda não têm a mídia: completa pelo source_id, sem duplicar
      completar = MIDIA_ATIVA ? midias_a_completar(inbox, normais) : []
      c[:mensagens_a_completar_com_midia] += completar.size
      if GRAVAR
        completar.each { |item| completar_midias!(inbox, item, c) }
      else
        contar_midias_seco(completar.flat_map { |item| item[:n][:midias].select { |m| item[:faltam].include?(m[:idx]) } }, c)
      end
      if novas.empty?
        c[:conversas_sem_mensagem_nova] += 1
        seguidos = 0
        next
      end

      c[situacao == :novo ? :contatos_novos : :contatos_reaproveitados] += 1
      c[:contatos_reaproveitados_do_messenger] += 1 if situacao == :reaproveitado_do_messenger
      conversa_existente = contato_id && Conversation.where(inbox_id: inbox.id, contact_id: contato_id)
                                                      .where('additional_attributes @> ?::jsonb', { S::MARCA_CONVERSA => conv['id'] }.to_json).first
      c[conversa_existente ? :conversas_historico_atualizadas : :conversas_historico_novas] += 1
      c[:mensagens_a_gravar] += novas.size
      # contagens que o João precisa ver ANTES de gravar: (a) última mensagem a partir de 14/11 (apareceria no funil se não fosse arquivo);
      # (b) a última é do PACIENTE e tem menos de 72 h (lead sem resposta que ficaria enterrado como «resolvido»)
      c[:ultima_msg_desde_14_11] += 1 if novas.last[:ts] >= DESDE_14_11
      c[:ultima_msg_do_paciente_menos_de_72h] += 1 if novas.last[:entrada] && novas.last[:ts] >= RECENTE_72H
      contar_midias_seco(novas.flat_map { |m| m[:midias] }, c) if MIDIA_ATIVA && !GRAVAR
      next unless GRAVAR

      perfil = (canal == :instagram && situacao == :novo) ? fonte.perfil_instagram(externo_id) : nil
      gravar_conversa!(inbox, canal, conv, externo, perfil, contato_id, ci_id, conversa_existente, novas, tag, c)
      seguidos = 0
    rescue S::Parar
      raise
    rescue S::ErroDaMeta => e # conversa que a Meta não entrega (apagada, id inválido): pula só ela
      c[:erros_da_meta] += 1
      seguidos += 1
      log "caixa #{inbox.id}: a Meta recusou uma conversa (#{erro_seguro(e)})"
      raise S::Parar, '10 erros seguidos — paro' if seguidos >= 10
    rescue StandardError => e
      c[:erros_no_banco] += 1
      seguidos += 1
      log "caixa #{inbox.id}: erro em uma conversa (#{erro_seguro(e)})"
      raise S::Parar, '10 erros seguidos — paro' if seguidos >= 10
    end
  end
rescue S::ErroDaMeta => e # a própria LISTA de conversas falhou (página inteira): encerra esta caixa, o resumo e o registro seguem valendo
  c[:lista_interrompida] = 1
  log "caixa #{inbox.id}: a lista de conversas da Meta foi interrompida (#{erro_seguro(e)}) — rode de novo para o resto"
ensure
  if c
    if fonte.respond_to?(:graph) && fonte.graph
      c[:chamadas_a_meta] = fonte.graph.chamadas
      c[:uso_maximo_da_cota_pct] = fonte.graph.uso_maximo.round
    end
    tipos.sort_by { |k, _| k.to_s }.each { |k, v| c["anexo_#{k}".to_sym] = v }
    %i[midias_bytes_estimados midias_bytes_gravados].each do |k|
      c[k.to_s.sub('bytes', 'mb').to_sym] = (c.delete(k) / 1_048_576.0).round(1) if c.key?(k)
    end
  end
end

# Grava UMA conversa de histórico numa transação e, só DEPOIS do commit, imprime o registro de ids (REG) dela — assim uma rodada
# interrompida no meio já deixou o registro de tudo o que foi confirmado.
def gravar_conversa!(inbox, canal, conv, externo, perfil, contato_id, ci_id, conversa_existente, novas, tag, c)
  # mídia: baixa ANTES da transação (rede lenta não segura o banco); o texto perde o rótulo só das partes que viraram anexo
  novas.each do |m|
    m[:prontos] = MIDIA_ATIVA ? baixar_midias(inbox, m, m[:midias].map { |x| x[:idx] }, c) : []
    m[:conteudo] = S.compor(m[:partes], m[:prontos].map { |p| p[:idx] })
  end
  ids = { contatos: [], contact_inboxes: [], conversas: [], taggings: [], mensagens: [], anexos: [], armazenamento: [], blobs: [] }
  begin
    gravar_no_banco!(inbox, canal, conv, externo, perfil, contato_id, ci_id, conversa_existente, novas, tag, ids)
  rescue StandardError
    descartar_blobs(novas.flat_map { |m| m[:prontos] || [] }) # a transação voltou: os arquivos já enviados não ficam órfãos
    raise
  end
  c[:mensagens_gravadas] += novas.size
  ids.each { |tipo, lista| reg(tipo.to_s, inbox.id, lista.uniq) unless tipo == :blobs } # blobs já foram para o registro no download
end

def gravar_no_banco!(inbox, canal, conv, externo, perfil, contato_id, ci_id, conversa_existente, novas, tag, ids)
  primeira = novas.first[:ts]
  ultima = novas.last[:ts]
  agora = Time.now.utc
  ActiveRecord::Base.transaction do
    unless contato_id
      nome, usuario = nome_do_contato(canal, externo, perfil)
      extras = usuario.to_s.empty? ? {} : { 'social_profiles' => { 'instagram' => usuario }, 'social_instagram_user_name' => usuario }
      contato_id = Contact.insert_all!([{ account_id: inbox.account_id, name: nome, additional_attributes: canal == :instagram ? extras : {}, custom_attributes: {},
                                          contact_type: 1, blocked: false, last_activity_at: ultima, created_at: primeira, updated_at: ultima }],
                                       returning: %w[id]).rows.first.first
      ids[:contatos] << contato_id
    end
    unless ci_id
      ci_id = ContactInbox.insert_all!([{ inbox_id: inbox.id, contact_id: contato_id, source_id: externo[0], hmac_verified: false,
                                          pubsub_token: SecureRandom.base58(24), created_at: primeira, updated_at: ultima }],
                                       returning: %w[id]).rows.first.first
      ids[:contact_inboxes] << ci_id
    end
    if conversa_existente
      cid = conversa_existente.id
      # a conversa de histórico só é mexida se continua RESOLVIDA (se a equipe reabriu, ganha as mensagens mas nada mais muda)
      if conversa_existente.status == 'resolved'
        Conversation.where(id: cid).update_all(["created_at = LEAST(created_at, ?), last_activity_at = GREATEST(last_activity_at, ?), " \
                                                'updated_at = GREATEST(updated_at, ?), agent_last_seen_at = GREATEST(agent_last_seen_at, ?)', primeira, ultima, ultima, ultima])
      end
    else
      cid = Conversation.insert_all!([{
        account_id: inbox.account_id, inbox_id: inbox.id, contact_id: contato_id, contact_inbox_id: ci_id, status: 1, assignee_id: nil,
        additional_attributes: { S::MARCA_CONVERSA => conv['id'] }, custom_attributes: {}, cached_label_list: S::ETIQUETA,
        created_at: primeira, updated_at: ultima, last_activity_at: ultima, status_changed_at: ultima,
        agent_last_seen_at: ultima, assignee_last_seen_at: ultima, waiting_since: nil
      }], returning: %w[id]).rows.first.first
      ids[:conversas] << cid
      ids[:taggings] << ActsAsTaggableOn::Tagging.insert_all!([{ tag_id: tag.id, taggable_type: 'Conversation', taggable_id: cid, context: 'labels', created_at: agora }],
                                                              returning: %w[id]).rows.first.first
    end
    novas.each_slice(500) do |fatia|
      linhas = fatia.map do |m|
        base = { account_id: inbox.account_id, inbox_id: inbox.id, conversation_id: cid, private: false, content_type: 0,
                 content: m[:conteudo], processed_message_content: m[:conteudo], source_id: m[:mid], created_at: m[:ts], updated_at: m[:ts],
                 additional_attributes: m[:prontos].any? ? { 'hist_conteudo_original' => m[:texto] } : {} }
        if m[:entrada]
          base.merge(message_type: 0, status: 0, sender_type: 'Contact', sender_id: contato_id, content_attributes: {})
        else
          # igual ao «eco» que o Chatwoot grava quando a página responde pelo app: sem remetente, marcado como externo
          base.merge(message_type: 1, status: 1, sender_type: nil, sender_id: nil, content_attributes: { external_echo: true })
        end
      end
      Message.insert_all!(linhas, returning: %w[id source_id]).rows.each do |mid, sid|
        ids[:mensagens] << mid
        fatia.find { |m| m[:mid] == sid }[:id] = mid
      end
    end
    novas.each { |m| gravar_anexos!(inbox.account_id, m[:id], m[:prontos], m[:ts], ids) if m[:prontos].any? }
  end
end

def contar_pendentes_de_vida(inbox_ids)
  # fotografia das conversas VIVAS (não importadas): a importação não toca nelas; a conferência final mostra que só mudaram pelo uso normal
  Conversation.where(inbox_id: inbox_ids).where('NOT COALESCE(jsonb_exists(additional_attributes, ?), false)', S::MARCA_CONVERSA).count
end

def imprimir_resumo(resumo, vivas_antes)
  resumo.each do |caixa, c|
    log "RESUMO caixa #{caixa}: " + c.sort_by { |k, _| k.to_s }.map { |k, v| "#{k}=#{v}" }.join(' ')
  end
  log "conversas vivas nas caixas: antes=#{vivas_antes} depois=#{contar_pendentes_de_vida(CAIXAS)} (a diferença é uso normal; a importação só grava conversas de histórico)"
rescue StandardError
  nil
end

# ─── execução ───────────────────────────────────────────────────────────────────────────────────────────────────────
log "início — #{GRAVAR ? 'GRAVANDO' : 'CONFERÊNCIA EM SECO (nada é escrito)'}; caixas #{CAIXAS.inspect}; corte #{CORTE_INFORMADO ? CORTE_INFORMADO.iso8601 : 'a criação de cada caixa'}#{FIXTURES ? '; FONTE = fixtures (teste)' : ''}"
resumo = {}
vivas_antes = nil
begin
  raise ErroNosso, ERROS_DE_PARAMETRO.join('; ') unless ERROS_DE_PARAMETRO.empty?

  if ENV['MODO'] == 'desfazer'
    desfazer!
    log 'FIM'
    exit 0
  end

  tag = ActsAsTaggableOn::Tag.find_by(name: S::ETIQUETA)
  raise ErroNosso, "a etiqueta '#{S::ETIQUETA}' não existe (crie-a no CRM antes)" if tag.nil?

  inboxes = Inbox.where(id: CAIXAS).order(:id).to_a
  raise ErroNosso, "caixa(s) não encontrada(s): #{CAIXAS - inboxes.map(&:id)}" if inboxes.size != CAIXAS.size

  vivas_antes = contar_pendentes_de_vida(CAIXAS)
  inboxes.each do |inbox|
    importar_caixa!(inbox, tag, resumo)
  rescue S::Parar => e
    log "PAREI na caixa #{inbox.id}: #{e.message}"
    (resumo[inbox.id] ||= zerar)[:parou] = 1
    break
  end
  $ultimo_resumo = resumo
  imprimir_resumo(resumo, vivas_antes)
  log 'FIM'
rescue StandardError => e
  log "ERRO FATAL (#{erro_seguro(e)})"
  imprimir_resumo(resumo, vivas_antes) unless resumo.empty? # o que a 1ª caixa já fez não se perde se a 2ª quebrar
  log 'FIM'
  exit 1
end
