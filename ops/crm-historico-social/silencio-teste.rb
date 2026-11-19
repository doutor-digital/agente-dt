# frozen_string_literal: true

# PROVA DE SILÊNCIO — roda só dentro do testar-silencio.sh, numa instalação DESCARTÁVEL do Chatwoot (banco vazio, sem dado de paciente,
# sem acesso à produção). Monta uma conta com webhook + automação nativa («sair» -> etiqueta) ligados, mede o que dispara numa criação
# NORMAL de mensagem (controle positivo: tem de dar > 0), roda a importação de verdade (importar-historico-social.rb com fixtures no lugar da
# Meta) e confere que NADA disparou: zero eventos do Chatwoot, zero jobs, zero HTTP, zero e-mail, zero notificação, e que as conversas
# vivas ficaram idênticas.
#   fase 1 (este arquivo, FASE=1): semeia, mede o controle, importa, confere.   fase 2 (FASE=2): repete a importação e confere a idempotência.
#   fase 3 (FASE=3): rotina dos «John Doe».   fase 4 (FASE=4): chega mensagem NOVA do Instagram pelo caminho normal depois da importação.
require 'json'
require 'set'

$falhas = 0
def confere(nome, condicao, detalhe = nil)
  puts "#{condicao ? 'PASSOU' : 'FALHOU'}  #{nome}#{detalhe && !condicao ? " -> #{detalhe}" : ''}"
  $falhas += 1 unless condicao
end

DIR = File.dirname(File.expand_path(__FILE__))
FASE = (ENV['FASE'] || '1').to_i
TRAB = ENV['TRAB'] || '/work'
FIX = File.join(TRAB, 'fixtures-historico.json')
AGORA_ARQ = File.join(TRAB, 'agora.txt')
AGORA = FASE == 1 ? Time.now.utc.change(usec: 0) : Time.iso8601(File.read(AGORA_ARQ).strip) # as fases seguintes usam o MESMO «agora»
File.write(AGORA_ARQ, AGORA.iso8601) if FASE == 1

# ── servidor de mídia do teste: o que a CDN da Meta entregaria (porta fixa, só dentro do contêiner descartável) ──
require 'socket'
PNG = "\x89PNG\r\n\x1a\n".b
class ServidorDeMidia
  def initialize(flaky_ok:)
    @flaky_ok = flaky_ok
    @srv = TCPServer.new('127.0.0.1', 18_765)
    Thread.new do
      loop { Thread.new(@srv.accept) { |c| atender(c) } }
    rescue IOError
      nil
    end
  end

  def atender(s)
    metodo, caminho = s.gets.to_s.split
    while (l = s.gets) && l != "\r\n"; end
    st, ct, corpo, cl = case caminho
                        when '/ok.png' then [200, 'image/png', PNG]
                        when '/voz.m4a' then [200, 'audio/mp4', 'v' * 300]
                        when '/video.mp4' then [200, 'video/mp4', 'm' * 500]
                        when '/doc.pdf' then [200, 'application/pdf', '%PDF-1.4 teste']
                        when '/flaky.png' then @flaky_ok ? [200, 'image/png', PNG] : [500, 'text/plain', 'erro']
                        when '/pagina-de-erro' then [200, 'text/html', '<html>expirou</html>']
                        when '/grande.png' then [200, 'image/png', '', 2_000_000]
                        else [404, 'text/plain', 'nao']
                        end
    s.write("HTTP/1.1 #{st} X\r\nContent-Type: #{ct}\r\nContent-Length: #{cl || corpo.bytesize}\r\nConnection: close\r\n\r\n")
    s.write(corpo) unless metodo == 'HEAD'
  rescue Errno::EPIPE, Errno::ECONNRESET
    nil
  ensure
    s.close
  end
end
ENV['MIDIA_MAX_MB'] = '1'
ENV['MIDIA_MIN_LIVRE_MB'] = '0'
ServidorDeMidia.new(flaky_ok: FASE >= 2) if [1, 2, 5, 6].include?(FASE)
U = ->(c) { "http://127.0.0.1:18765#{c}" }

# ── instrumentos ──
$medindo = false
$conta = Hash.new(0)
module Medidor
  def dispatch(*args, **kw, &blk)
    $conta[:eventos_chatwoot] += 1 if $medindo
    super
  end
end
Dispatcher.prepend(Medidor)
module MedidorHttp
  def request(*args, &blk)
    $conta[address == '127.0.0.1' ? :http_midia_local : :http_externo] += 1 if $medindo # 127.0.0.1 = servidor de mídia do TESTE (o download)
    super
  end
end
Net::HTTP.prepend(MedidorHttp)
module MedidorSidekiq
  def raw_push(payloads)
    $conta[:jobs_sidekiq] += payloads.size if $medindo
    super
  end
end
Sidekiq::Client.prepend(MedidorSidekiq)
ActiveSupport::Notifications.subscribe('enqueue.active_job') { |*| $conta[:jobs_activejob] += 1 if $medindo }
ActiveSupport::Notifications.subscribe('perform_start.active_job') { |*| $conta[:jobs_executados] += 1 if $medindo }
ActiveSupport::Notifications.subscribe('deliver.action_mailer') { |*| $conta[:emails] += 1 if $medindo }
ActiveJob::Base.queue_adapter = :inline # se algo disparasse, EXECUTARIA aqui (webhook, automação) — e apareceria nos números

# o importador define constantes ao ser carregado; para carregá-lo de novo no mesmo processo, tira todas
def limpar_constantes
  %i[GRAVAR CAIXAS CORTE_INFORMADO LIMITE RITMO INICIO FIXTURES ERROS_DE_PARAMETRO DESDE_14_11 RECENTE_72H].each { |k| Object.send(:remove_const, k) if Object.const_defined?(k) }
end

# «silêncio» = nada disparou. Os downloads de mídia ao servidor local de teste são o trabalho da importação, não uma reação.
def silencio?
  $conta.reject { |k, _| k == :http_midia_local }.values.sum.zero?
end

def medir
  $conta.clear
  $medindo = true
  yield
ensure
  $medindo = false
end

def foto_viva(conv)
  conv.reload
  [conv.last_activity_at.to_f, conv.updated_at.to_f, conv.status, conv.assignee_id, conv.messages.count, conv.label_list.sort, conv.priority, conv.waiting_since, conv.agent_last_seen_at.to_f]
end

if FASE == 1
  # ── semeia ──
  ActiveJob::Base.queue_adapter = :test
  [Channel::Instagram, Channel::FacebookPage].each do |k|
    k.skip_callback(:create, :after, :subscribe, raise: false)
    k.skip_callback(:commit, :after, :subscribe, raise: false)
  end
  conta = Account.create!(name: 'Teste')
  agente = User.new(name: 'Agente', email: 'agente@teste.invalid', password: 'Teste1234!x', password_confirmation: 'Teste1234!x')
  agente.skip_confirmation!
  agente.save!
  AccountUser.create!(account: conta, user: agente, role: :administrator)
  ig_ch = Channel::Instagram.create!(account: conta, access_token: 'x', expires_at: AGORA + 86_400 * 30, instagram_id: '17841000000000001')
  ig = Inbox.create!(account: conta, channel: ig_ch, name: 'ig', lock_to_single_conversation: false)
  fb_ch = Channel::FacebookPage.create!(account: conta, page_id: '109875000000001', user_access_token: 'u', page_access_token: 'p')
  fb = Inbox.create!(account: conta, channel: fb_ch, name: 'fb', lock_to_single_conversation: false)
  [ig, fb].each { |i| InboxMember.create!(inbox: i, user: agente) }
  Label.create!(account: conta, title: 'historico')
  Label.create!(account: conta, title: 'sair')
  ActsAsTaggableOn::Tag.find_or_create_by!(name: 'historico')
  Webhook.create!(account: conta, url: 'http://webhook.invalid/x', subscriptions: %w[conversation_updated message_created conversation_created conversation_status_changed])
  AutomationRule.create!(account: conta, name: 'sair', event_name: 'message_created', active: true,
                         conditions: [{ attribute_key: 'content', filter_operator: 'contains', values: ['sair'], query_operator: nil }],
                         actions: [{ action_name: 'add_label', action_params: ['sair'] }])
  AutomationRule.create!(account: conta, name: 'resolvida', event_name: 'conversation_resolved', active: true, conditions: [], actions: [{ action_name: 'add_label', action_params: ['sair'] }])

  # contatos que JÁ existem (nasceram pelo caminho normal) com conversa VIVA
  mk = lambda do |inbox, src, nome|
    ci = ContactInboxWithContactBuilder.new(source_id: src, inbox: inbox, contact_attributes: { name: nome }).perform
    conv = Conversation.create!(account: conta, inbox: inbox, contact: ci.contact, contact_inbox: ci)
    [ci.contact, conv]
  end
  ct_vivo, conv_vivo = mk.call(ig, 'ig_vivo', 'Vivo IG')
  conv_vivo.messages.create!(account: conta, inbox: ig, message_type: :incoming, content: 'mensagem viva', source_id: 'mid_live', sender: ct_vivo)
  ct_jd, conv_jd = mk.call(fb, 'fb_johndoe', 'John Doe')
  ct_ed, conv_ed = mk.call(fb, 'fb_editado', 'Nome Editado Pela Equipe')
  # espera os jobs/ações da semeadura acabarem e zera tudo antes de medir
  conv_vivo.update_columns(last_activity_at: AGORA - 120)
  Sidekiq.redis(&:flushdb)
  vivas = { vivo: conv_vivo, jd: conv_jd, ed: conv_ed }
  fotos_antes = vivas.transform_values { |c| foto_viva(c) }
  notif_antes = Notification.count
  reporting_antes = ReportingEvent.count

  ActiveJob::Base.queue_adapter = :inline
  # ── controle positivo: criação NORMAL de uma mensagem com a palavra «sair» DEVE mexer em tudo ──
  controle = Conversation.create!(account: conta, inbox: ig, contact: ct_vivo, contact_inbox: ct_vivo.contact_inboxes.first)
  medir { controle.messages.create!(account: conta, inbox: ig, message_type: :incoming, content: 'quero sair da lista', source_id: 'mid_controle', sender: ct_vivo) }
  puts "controle (criação normal): #{$conta.sort.map { |k, v| "#{k}=#{v}" }.join(' ')}"
  confere('controle positivo: o medidor ENXERGA eventos do Chatwoot na criação normal', $conta[:eventos_chatwoot].positive?)
  confere('controle positivo: o medidor enxerga jobs na criação normal', ($conta[:jobs_activejob] + $conta[:jobs_sidekiq]).positive?)
  confere('controle positivo: a automação nativa REALMENTE reagiu (etiqueta sair)', controle.reload.label_list.include?('sair'), controle.label_list.inspect)
  # restaura o estado «antes» das vivas (o controle mexeu na conversa de controle, que sai da conferência)
  controle_ids = [controle.id]
  fotos_antes = vivas.transform_values { |c| foto_viva(c) }
  notif_antes = Notification.count
  reporting_antes = ReportingEvent.count

  # ── fixtures (o que a Meta devolveria) ──
  t = ->(min) { (AGORA - (min * 60)).strftime('%Y-%m-%dT%H:%M:%S+0000') }
  pagina_ig = ig_ch.instagram_id
  pagina_fb = fb_ch.page_id
  msgs_ig_novo = [
    { 'id' => 'ig_m4', 'created_time' => t.call(3000), 'from' => { 'id' => pagina_ig, 'username' => 'clinica' }, 'message' => '', 'attachments' => { 'data' => [{ 'generic_template' => { 'title' => 'Agende agora', 'cta' => [{ 'url' => 'https://x' }] } }] } },
    { 'id' => 'ig_m3', 'created_time' => t.call(3001), 'from' => { 'id' => 'ig_novo', 'username' => 'paciente_a' }, 'message' => 'tenho dor, é urgente, quero parar e sair', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => 'https://expira' } }] } },
    { 'id' => 'ig_m2', 'created_time' => t.call(3002), 'from' => { 'id' => pagina_ig, 'username' => 'clinica' }, 'message' => 'Olá! Como posso ajudar?' },
    { 'id' => 'ig_m1', 'created_time' => t.call(3002), 'from' => { 'id' => 'ig_novo', 'username' => 'paciente_a' }, 'message' => 'oi', 'is_unsupported' => false }
  ]
  msgs_ig_vivo = [
    { 'id' => 'mid_pos', 'created_time' => t.call(1), 'from' => { 'id' => 'ig_vivo', 'username' => 'vivo' }, 'message' => 'chegou depois do corte (webhook entrega)' },
    { 'id' => 'mid_live', 'created_time' => t.call(10), 'from' => { 'id' => 'ig_vivo', 'username' => 'vivo' }, 'message' => 'mensagem viva' },
    { 'id' => 'ig_v2', 'created_time' => t.call(5000), 'from' => { 'id' => pagina_ig }, 'message' => 'resposta antiga' },
    { 'id' => 'ig_v1', 'created_time' => t.call(5001), 'from' => { 'id' => 'ig_vivo', 'username' => 'vivo' }, 'message' => 'pergunta antiga, remarcar' }
  ]
  msgs_ig_tudo_ja_existe = [{ 'id' => 'mid_live', 'created_time' => t.call(10), 'from' => { 'id' => 'ig_vivo', 'username' => 'vivo' }, 'message' => 'mensagem viva' }]
  part = lambda { |pagina, id, nome: nil, usuario: nil, pagina_nome: 'Página'|
    { 'data' => [{ 'id' => pagina, 'name' => pagina_nome, 'username' => 'clinica' }, { 'id' => id, 'name' => nome, 'username' => usuario }.compact] }
  }
  msgs_fb = lambda { |psid, prefixo, n|
    (1..n).map do |i|
      { 'id' => "#{prefixo}_#{i}", 'created_time' => t.call(9000 - (i * 10)), 'from' => { 'id' => i.odd? ? psid : pagina_fb, 'name' => 'x', 'email' => "#{psid}@facebook.com" }, 'message' => i.odd? ? "pergunta #{i}" : "resposta #{i}" }
    end.reverse
  }
  ig_midia = [
    { 'id' => 'mm7', 'created_time' => t.call(4000), 'from' => { 'id' => pagina_ig }, 'message' => '', 'attachments' => { 'data' => [{ 'video_data' => { 'url' => U.call('/video.mp4') }, 'mime_type' => 'video/mp4' }] } },
    { 'id' => 'mm6', 'created_time' => t.call(4001), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => '', 'story' => { 'mention' => { 'link' => 'x' } }, 'shares' => { 'data' => [{ 'link' => 'x' }] } },
    { 'id' => 'mm5', 'created_time' => t.call(4002), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => '', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => U.call('/grande.png') } }] } },
    { 'id' => 'mm4', 'created_time' => t.call(4003), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => '', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => U.call('/pagina-de-erro') } }] } },
    { 'id' => 'mm3', 'created_time' => t.call(4004), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => '', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => U.call('/flaky.png') } }] } },
    { 'id' => 'mm2', 'created_time' => t.call(4005), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => '', 'attachments' => { 'data' => [{ 'file_url' => U.call('/voz.m4a'), 'mime_type' => 'audio/mp4', 'size' => 300 }] } },
    { 'id' => 'mm1', 'created_time' => t.call(4006), 'from' => { 'id' => 'ig_midia', 'username' => 'midia' }, 'message' => 'segue o exame', 'attachments' => { 'data' => [
      { 'image_data' => { 'url' => U.call('/ok.png') }, 'mime_type' => 'image/png', 'name' => 'foto.png', 'size' => 8 },
      { 'file_url' => U.call('/doc.pdf'), 'mime_type' => 'application/pdf', 'name' => 'Exame Maria.pdf' }
    ] } }
  ]
  fb_midia = [
    { 'id' => 'fm2', 'created_time' => t.call(4100), 'from' => { 'id' => 'fb_midia' }, 'message' => '', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => U.call('/nao-existe.png') } }] } },
    { 'id' => 'fm1', 'created_time' => t.call(4101), 'from' => { 'id' => 'fb_midia' }, 'message' => '', 'sticker' => U.call('/ok.png') }
  ]
  fixtures = {
    'instagram' => {
      'conversas' => [
        { 'id' => 'cv_ig_midia', 'participants' => part.call(pagina_ig, 'ig_midia', usuario: 'midia'), 'messages' => ig_midia },
        { 'id' => 'cv_ig_novo', 'participants' => part.call(pagina_ig, 'ig_novo', usuario: 'paciente_a'), 'messages' => msgs_ig_novo },
        { 'id' => 'cv_ig_vivo', 'participants' => part.call(pagina_ig, 'ig_vivo', usuario: 'vivo'), 'messages' => msgs_ig_vivo },
        { 'id' => 'cv_ig_ja', 'participants' => part.call(pagina_ig, 'ig_vivo', usuario: 'vivo'), 'messages' => msgs_ig_tudo_ja_existe }
      ],
      'perfis' => { 'ig_novo' => { 'name' => 'Paciente A Nome Real', 'username' => 'paciente_a' } }
    },
    'messenger' => {
      'conversas' => [
        { 'id' => 'cv_fb_midia', 'participants' => part.call(pagina_fb, 'fb_midia', nome: 'Pessoa da Midia'), 'messages' => fb_midia },
        { 'id' => 'cv_fb_novo', 'participants' => part.call(pagina_fb, 'fb_novo', nome: 'Maria do Messenger'), 'messages' => msgs_fb.call('fb_novo', 'fbn', 5) },
        { 'id' => 'cv_fb_jd', 'participants' => part.call(pagina_fb, 'fb_johndoe', nome: 'Joana Nome Real'), 'messages' => msgs_fb.call('fb_johndoe', 'fbj', 3) },
        { 'id' => 'cv_fb_ed', 'participants' => part.call(pagina_fb, 'fb_editado', nome: 'Nome Antigo da Meta'), 'messages' => msgs_fb.call('fb_editado', 'fbe', 2) },
        { 'id' => 'cv_fb_vazia', 'participants' => part.call(pagina_fb, 'fb_vazio', nome: 'Sem Mensagem'), 'messages' => [{ 'id' => 'fbv_1', 'created_time' => t.call(100), 'from' => { 'id' => 'fb_vazio' }, 'message' => '' }] }
      ]
    }
  }
  File.write(FIX, fixtures.to_json)

  # ── importação de verdade (seco primeiro: não pode escrever nada) ──
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count] }
  base = contagem.call
  ENV['FIXTURES'] = FIX
  ENV['CAIXAS'] = "#{ig.id},#{fb.id}"
  ENV['CORTE'] = (AGORA - (20 * 60)).iso8601
  ENV['RITMO'] = '0'
  ENV.delete('GRAVAR')
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  confere('SECO não escreveu nada no banco', contagem.call == base, contagem.call.inspect)
  confere('SECO não disparou nada', silencio?, $conta.inspect)
  rs = $ultimo_resumo
  confere('SECO conta as mídias por tipo (IG: 2 imagens grandes/ruins + flaky + ok = 4 imagens, 1 áudio, 1 vídeo, 1 arquivo)', rs[ig.id][:midias_a_baixar_imagem] == 4 && rs[ig.id][:midias_a_baixar_audio] == 1 && rs[ig.id][:midias_a_baixar_video] == 1 && rs[ig.id][:midias_a_baixar_arquivo] == 1, rs[ig.id].select { |k, _| k.to_s.start_with?('midias') }.inspect)
  confere('SECO: Messenger conta a figurinha e a imagem', rs[fb.id][:midias_a_baixar_figurinha] == 1 && rs[fb.id][:midias_a_baixar_imagem] == 1, rs[fb.id].select { |k, _| k.to_s.start_with?('midias') }.inspect)
  confere('SECO estima MB e aponta o que passa do teto', rs[ig.id][:midias_mb_estimados].to_f.positive? && rs[ig.id][:midias_acima_do_teto] == 1, rs[ig.id].select { |k, _| k.to_s.start_with?('midias') }.inspect)
  confere('SECO não criou anexo nem arquivo', Attachment.none? && ActiveStorage::Blob.none?)

  # ── gravando ──
  limpar_constantes
  ENV['GRAVAR'] = '1'
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  puts "durante a importação: #{$conta.inspect}"
  confere('SILÊNCIO: zero eventos do Chatwoot (webhook/automação/notificação nascem deles)', $conta[:eventos_chatwoot].zero?, $conta.inspect)
  confere('SILÊNCIO: zero jobs enfileirados (Sidekiq/ActiveJob)', ($conta[:jobs_activejob] + $conta[:jobs_sidekiq] + $conta[:jobs_executados]).zero?, $conta.inspect)
  confere('SILÊNCIO: zero HTTP para fora (webhook do agente, Meta)', $conta[:http_externo].zero?, $conta.inspect)
  confere('SILÊNCIO: zero e-mail', $conta[:emails].zero?)
  confere('SILÊNCIO: zero notificação ao atendente', Notification.count == notif_antes)
  confere('SILÊNCIO: zero evento de relatório', ReportingEvent.count == reporting_antes)
  fotos_depois = vivas.transform_values { |c| foto_viva(c) }
  confere('conversas VIVAS idênticas (last_activity_at, updated_at, status, responsável, nº de mensagens, etiquetas, prioridade, não lidas)', fotos_antes == fotos_depois, "#{fotos_antes} != #{fotos_depois}")

  # ── dados ──
  hist = Conversation.where("additional_attributes ? 'meta_conversation_id'").order(:id).to_a
  confere('7 conversas de histórico nasceram (ig_novo, ig_vivo, ig_midia, fb_novo, fb_jd, fb_ed, fb_midia)', hist.size == 7, hist.size.to_s)
  confere('todas RESOLVIDAS', hist.all?(&:resolved?))
  confere('todas com a etiqueta historico e SÓ ela (a automação não pôs nada)', hist.all? { |c| c.reload.label_list == ['historico'] }, hist.map { |c| c.label_list }.inspect)
  confere('ninguém atribuído, sem prioridade, sem equipe', hist.all? { |c| c.assignee_id.nil? && c.priority.nil? && c.team_id.nil? })
  confere('sem espera de resposta (waiting_since nulo)', hist.all? { |c| c.waiting_since.nil? })
  confere('display_id veio do banco', hist.all? { |c| c.display_id.to_i.positive? })
  c_ig = hist.find { |c| c.additional_attributes['meta_conversation_id'] == 'cv_ig_novo' }
  ms = c_ig.messages.order(:created_at, :id).to_a
  confere('IG novo: 4 mensagens, a mais antiga primeiro', ms.map(&:source_id) == %w[ig_m1 ig_m2 ig_m3 ig_m4], ms.map(&:source_id).inspect)
  confere('IG novo: data/hora ORIGINAL', ms.first.created_at.to_i == (AGORA - 3002 * 60).to_i && ms.last.created_at.to_i == (AGORA - 3000 * 60).to_i)
  confere('IG novo: conversa com a data da última mensagem (não a de hoje)', c_ig.last_activity_at.to_i == (AGORA - 3000 * 60).to_i && c_ig.created_at.to_i == (AGORA - 3002 * 60).to_i)
  confere('IG novo: direção (recebida/enviada)', ms.map(&:message_type) == %w[incoming outgoing incoming outgoing], ms.map(&:message_type).inspect)
  confere('IG novo: recebida tem remetente = contato; enviada sem remetente e marcada externa', ms[0].sender == c_ig.contact && ms[1].sender.nil? && ms[1].content_attributes['external_echo'] == true)
  confere('IG novo: anexo vira texto, sem URL', ms[2].content == "tenho dor, é urgente, quero parar e sair\n[imagem]" && ms[3].content == '[mensagem com botões] Agende agora', ms.map(&:content).inspect)
  confere('IG novo: URL que não é da Meta (host fora da lista) NÃO é baixada: fica o rótulo e nenhum anexo', ms.all? { |m| m.attachments.none? })
  confere('IG novo: palavras de automação (sair/urgente/parar) NÃO acionaram etiqueta/nota/prioridade', c_ig.reload.label_list == ['historico'] && c_ig.messages.where(private: true).none? && c_ig.priority.nil?)
  confere('IG novo: contato criado com o IGSID como source_id e o nome do perfil', c_ig.contact_inbox.source_id == 'ig_novo' && c_ig.contact.name == 'Paciente A Nome Real', c_ig.contact.name)
  confere('IG novo: contato é lead, com @usuario guardado', c_ig.contact.contact_type == 'lead' && c_ig.contact.additional_attributes['social_instagram_user_name'] == 'paciente_a')
  confere('IG novo: contact_inbox com pubsub_token', c_ig.contact_inbox.pubsub_token.present?)
  c_vivo = hist.find { |c| c.additional_attributes['meta_conversation_id'] == 'cv_ig_vivo' }
  confere('IG vivo: só as 2 antigas entraram (a viva já existia; a pós-corte fica para o webhook)', c_vivo.messages.pluck(:source_id).sort == %w[ig_v1 ig_v2], c_vivo.messages.pluck(:source_id).inspect)
  confere('IG vivo: reaproveitou o MESMO contato da conversa viva', c_vivo.contact_id == ct_vivo.id && Contact.where(account_id: conta.id).where("name = 'Vivo IG'").count == 1)
  confere('IG vivo: a mensagem viva (mid_live) não foi duplicada', Message.where(source_id: 'mid_live').count == 1)
  confere('IG vivo: a pós-corte (mid_pos) NÃO foi gravada', Message.where(source_id: 'mid_pos').none?)
  confere('IG: conversa «tudo já existe» não criou conversa nem contato', hist.none? { |c| c.additional_attributes['meta_conversation_id'] == 'cv_ig_ja' })
  c_fbn = hist.find { |c| c.additional_attributes['meta_conversation_id'] == 'cv_fb_novo' }
  confere('FB novo: contato com o nome da conversa da página e PSID de source_id', c_fbn.contact.name == 'Maria do Messenger' && c_fbn.contact_inbox.source_id == 'fb_novo', c_fbn.contact.name)
  confere('FB novo: 5 mensagens, alternando', c_fbn.messages.order(:created_at, :id).pluck(:message_type) == %w[incoming outgoing incoming outgoing incoming], c_fbn.messages.pluck(:message_type).inspect)
  confere('FB: «John Doe» trocado pelo nome real', ct_jd.reload.name == 'Joana Nome Real', ct_jd.name)
  confere('FB: nome editado pela equipe NÃO foi sobrescrito', ct_ed.reload.name == 'Nome Editado Pela Equipe', ct_ed.name)
  confere('FB: conversa sem texto (vazia) não criou contato nem conversa', Contact.where(account_id: conta.id).where("name = 'Sem Mensagem'").none?)
  confere('FB jd: conversa viva do John Doe intacta', conv_jd.reload.messages.count == 0 && conv_jd.status == 'open')
  # ── mídia anexada de verdade ──
  c_mid = hist.find { |c| c.additional_attributes['meta_conversation_id'] == 'cv_ig_midia' }
  mm = c_mid.messages.index_by(&:source_id)
  confere('MÍDIA: 5 anexos no Instagram (imagem+arquivo, áudio, vídeo) e 1 sticker no Messenger = 5 no total', Attachment.count == 5, Attachment.count.to_s)
  a1 = mm['mm1'].attachments.order(:id).to_a
  confere('MÍDIA: imagem e arquivo da mm1 anexados, com o file_type certo', a1.map(&:file_type) == %w[image file], a1.map(&:file_type).inspect)
  confere('MÍDIA: o arquivo está no ActiveStorage e o conteúdo é o baixado', a1.all? { |a| a.file.attached? } && a1[0].file.download == PNG && a1[1].file.download == '%PDF-1.4 teste')
  confere('MÍDIA: nome do arquivo guardado', a1[0].file.filename.to_s == 'foto.png' && a1[1].file.filename.to_s == 'Exame Maria.pdf', a1.map { |a| a.file.filename.to_s }.inspect)
  confere('MÍDIA: a mensagem perde só o rótulo de quem virou anexo (texto fica)', mm['mm1'].content == 'segue o exame', mm['mm1'].content.inspect)
  confere('MÍDIA: guarda o texto de antes para o desfazer', mm['mm1'].additional_attributes['hist_conteudo_original'] == "segue o exame\n[imagem]\n[arquivo]")
  confere('MÍDIA: só mídia = content nulo (como o Chatwoot grava)', mm['mm2'].content.nil? && mm['mm2'].attachments.first.file_type == 'audio' && mm['mm7'].content.nil? && mm['mm7'].attachments.first.file_type == 'video')
  confere('MÍDIA: falhas ficam com o rótulo (500 da CDN, página de erro HTML, acima do teto) e sem anexo', %w[mm3 mm4 mm5].all? { |k| mm[k].content == '[imagem]' && mm[k].attachments.none? })
  confere('MÍDIA: story/compartilhamento continuam rótulo', mm['mm6'].content == "[compartilhamento]\n[menção em story]" && mm['mm6'].attachments.none?)
  c_fbm = hist.find { |c| c.additional_attributes['meta_conversation_id'] == 'cv_fb_midia' }
  fmm = c_fbm.messages.index_by(&:source_id)
  confere('MÍDIA: sticker do Messenger vira imagem; 404 fica rótulo', fmm['fm1'].attachments.first&.file_type == 'image' && fmm['fm1'].content.nil? && fmm['fm2'].content == '[imagem]' && fmm['fm2'].attachments.none?)
  confere('MÍDIA: downloads foram feitos (só ao servidor de teste)', $conta[:http_midia_local].to_i >= 5 && $conta[:http_externo].zero?, $conta.inspect)
  ActiveStorage::Current.url_options = { host: 'teste.invalid', protocol: 'http' } # numa requisição de verdade o Chatwoot põe o host
  pe = mm['mm1'].push_event_data[:attachments]
  confere('MÍDIA: o painel monta a mensagem com o anexo (data_url presente)', pe.size == 2 && pe.all? { |x| x[:data_url].to_s.include?('/rails/active_storage/') } && mm['mm1'].webhook_data[:attachments].size == 2, pe.map { |x| x.slice(:file_type, :extension).merge(url: x[:data_url].to_s[0, 40]) }.inspect)
  confere('MÍDIA: no Instagram, mensagem RECEBIDA mostra pelo link permanente do NOSSO arquivo (external_url), nunca o da Meta', a1.all? { |a| a.external_url.to_s.include?('/rails/active_storage/blobs/redirect/') && !a.external_url.to_s.include?('127.0.0.1') } && ActiveStorage::Blob.find_signed!(a1[0].external_url.split('/redirect/').last.split('/').first) == a1[0].file.blob, a1.map(&:external_url).inspect)
  confere('MÍDIA: mensagem ENVIADA pela página (vídeo) também tem link', mm['mm7'].attachments.first.external_url.to_s.include?('/rails/active_storage/'))
  confere('MÍDIA: o resumo conta baixadas e falhas por motivo', $ultimo_resumo[ig.id][:midias_baixadas_imagem] == 1 && $ultimo_resumo[ig.id][:midias_falha_http] == 1 && $ultimo_resumo[ig.id][:midias_falha_tipo] == 1 && $ultimo_resumo[ig.id][:midias_falha_tamanho] == 1, $ultimo_resumo[ig.id].select { |k, _| k.to_s.start_with?('midias') }.inspect)
  confere('MÍDIA: nenhum ActiveStorage::Attachment ou Attachment fora do que o registro conhece (blobs = anexos)', ActiveStorage::Blob.count == 5 && ActiveStorage::Attachment.count == 5)
  # renderização: o que o painel, a API e o webhook montam a partir dessas linhas não pode quebrar
  hist.each do |c|
    c.messages.each { |m| m.push_event_data; m.webhook_data }
    c.push_event_data
    c.webhook_data
    c.contact.push_event_data
  end
  confere('renderização (push_event_data/webhook_data) sem erro em conversa, mensagem e contato', true)
end

if FASE == 2
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count] }
  antes = contagem.call
  anexos_antes = Attachment.count
  ENV['FIXTURES'] = FIX
  ENV['GRAVAR'] = '1'
  ENV['RITMO'] = '0'
  ig = Inbox.find_by(name: 'ig')
  fb = Inbox.find_by(name: 'fb')
  ENV['CAIXAS'] = "#{ig.id},#{fb.id}"
  ENV['CORTE'] = (AGORA - (20 * 60)).iso8601
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  confere('IDEMPOTENTE: 2ª rodada não criou nem uma linha', contagem.call == antes, "#{antes} -> #{contagem.call}")
  confere('IDEMPOTENTE: 2ª rodada também em silêncio', silencio?, $conta.inspect)
  # a CDN agora entrega o que falhou na 1ª rodada (flaky.png): a mensagem JÁ importada recebe a mídia, pelo source_id, sem duplicar nada
  mm3 = Message.find_by(source_id: 'mm3')
  confere('COMPLETAR: a mídia que falhou antes entrou na mensagem já importada (1 anexo novo, mesma mensagem)', Attachment.count == anexos_antes + 1 && mm3.attachments.count == 1 && mm3.attachments.first.file.attached?, "#{anexos_antes} -> #{Attachment.count}")
  confere('COMPLETAR: o rótulo saiu e o texto de antes ficou guardado', mm3.content.nil? && mm3.additional_attributes['hist_conteudo_original'] == '[imagem]', mm3.content.inspect)
  confere('COMPLETAR: o resumo conta 1 mensagem completada', $ultimo_resumo[ig.id][:mensagens_completadas_com_midia] == 1 && $ultimo_resumo[ig.id][:mensagens_a_completar_com_midia] == 4, $ultimo_resumo[ig.id].select { |k, _| k.to_s.start_with?('mensagens_') && k.to_s.include?('complet') }.inspect)
  confere('COMPLETAR: quem já tinha a mídia (mm1, mm2, mm7) não foi baixado de novo', Message.find_by(source_id: 'mm1').attachments.count == 2 && Message.find_by(source_id: 'mm2').attachments.count == 1)
  # a Meta devolve mais uma mensagem antiga numa conversa já importada: entra NA MESMA conversa de histórico
  j = JSON.parse(File.read(FIX))
  j['instagram']['conversas'].find { |cv| cv['id'] == 'cv_ig_novo' }['messages'] << { 'id' => 'ig_m0', 'created_time' => (AGORA - (4000 * 60)).strftime('%Y-%m-%dT%H:%M:%S+0000'), 'from' => { 'id' => 'ig_novo' }, 'message' => 'mais antiga ainda' }
  File.write(FIX, j.to_json)
  limpar_constantes
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  c_ig = Conversation.where("additional_attributes @> ?::jsonb", { meta_conversation_id: 'cv_ig_novo' }.to_json).to_a
  confere('mensagem velha que apareceu depois entra na MESMA conversa (1 conversa, 5 mensagens)', c_ig.size == 1 && c_ig.first.messages.count == 5, c_ig.map { |c| c.messages.count }.inspect)
  confere('...e a conversa passa a começar na mensagem mais antiga', c_ig.first.created_at.to_i == (AGORA - 4000 * 60).to_i)
  confere('...em silêncio', silencio?, $conta.inspect)
  confere('COMPLETAR: a 3ª rodada não acrescenta mais nada (idempotente também na mídia)', Attachment.count == anexos_antes + 1)
end

if FASE == 3
  # rotina dos John Doe: usa FIXTURES (conversa da página por user_id) no lugar da Meta
  fb = Inbox.find_by(name: 'fb')
  ci = ContactInboxWithContactBuilder.new(source_id: 'fb_johndoe2', inbox: fb, contact_attributes: { name: 'John Doe' }).perform
  conv = Conversation.create!(account: fb.account, inbox: fb, contact: ci.contact, contact_inbox: ci)
  ci_ed = ContactInboxWithContactBuilder.new(source_id: 'fb_editado2', inbox: fb, contact_attributes: { name: 'John Doe' }).perform
  Sidekiq.redis(&:flushdb)
  ci_ed.contact.update_columns(name: 'Editado Agora')
  pagina = fb.channel.page_id
  File.write(FIX, { 'messenger' => { 'conversas' => [
    { 'id' => 'c1', 'participants' => { 'data' => [{ 'id' => pagina, 'name' => 'P' }, { 'id' => 'fb_johndoe2', 'name' => 'Nome Real Dois' }] } },
    { 'id' => 'c2', 'participants' => { 'data' => [{ 'id' => pagina, 'name' => 'P' }, { 'id' => 'fb_editado2', 'name' => 'Nome da Meta' }] } }
  ] } }.to_json)
  foto = foto_viva(conv)
  upd = conv.reload.updated_at.to_f
  ENV['FIXTURES'] = FIX
  ENV['GRAVAR'] = '1'
  ENV['CAIXA'] = fb.id.to_s
  ENV['DIAS'] = '3'
  ENV['RITMO'] = '0'
  medir { load File.join(DIR, 'corrigir-nomes-messenger.rb') }
  confere('NOMES: John Doe novo corrigido', ci.contact.reload.name == 'Nome Real Dois', ci.contact.name)
  confere('NOMES: nome editado no meio do caminho não foi sobrescrito', ci_ed.contact.reload.name == 'Editado Agora', ci_ed.contact.name)
  confere('NOMES: silêncio total (eventos, jobs, HTTP, e-mail)', silencio?, $conta.inspect)
  confere('NOMES: conversa do contato intacta (last_activity_at, updated_at, etc.)', foto_viva(conv) == foto && conv.updated_at.to_f == upd)
end

if FASE == 3
  # fila dos «John Doe»: quem a Meta não nomeia (os mais novos) não pode prender os mais antigos
  require File.join(DIR, 'historico_social')
  fb = Inbox.find_by(name: 'fb')
  velho = ContactInboxWithContactBuilder.new(source_id: 'fb_velho', inbox: fb, contact_attributes: { name: 'John Doe' }).perform.contact
  velho.update_columns(created_at: Time.now.utc - 86_400)
  novos = (1..6).map { |i| ContactInboxWithContactBuilder.new(source_id: "fb_sem_#{i}", inbox: fb, contact_attributes: { name: 'John Doe' }).perform.contact }
  escopo = Contact.joins(:contact_inboxes).where(contact_inboxes: { inbox_id: fb.id }).where(HistoricoSocial.sql_nome_padrao('contacts.name'))
  sorteios = (0..40).map { |slot| HistoricoSocial.escolher_candidatos(escopo, 2, slot) }
  confere('FILA: o contato mais novo sempre entra', sorteios.all? { |ids| ids.include?(novos.last.id) })
  confere('FILA: o mais antigo também é alcançado (rodízio), mesmo com 6 mais novos sem nome', sorteios.any? { |ids| ids.include?(velho.id) })
  confere('FILA: respeita o máximo', sorteios.all? { |ids| ids.size == 2 })
end

if FASE == 6
  # parâmetros ruins são RECUSADOS antes de ler ou gravar qualquer coisa
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count] }
  recusa = lambda do |env|
    antes = contagem.call
    limpar_constantes
    ENV.update(env)
    saiu = begin
      load File.join(DIR, 'importar-historico-social.rb')
      nil
    rescue SystemExit => e
      e.status
    end
    [saiu, contagem.call == antes]
  end
  ENV['FIXTURES'] = FIX
  ENV['GRAVAR'] = '1'
  ENV['RITMO'] = '0'
  ENV['CAIXAS'] = "#{Inbox.find_by(name: 'ig').id},#{Inbox.find_by(name: 'fb').id}"
  st, igual = recusa.call('LIMITE_CONVERSAS' => '0', 'CORTE' => '')
  confere('LIMITE_CONVERSAS=0 é recusado (não vira «sem limite») e nada é gravado', st == 1 && igual, [st, igual].inspect)
  st, igual = recusa.call('LIMITE_CONVERSAS' => '', 'CORTE' => (Time.now.utc - 60).iso8601)
  confere('CORTE depois de início − 15 min é recusado e nada é gravado', st == 1 && igual, [st, igual].inspect)
  st, igual = recusa.call('LIMITE_CONVERSAS' => '', 'CORTE' => 'ontem')
  confere('CORTE ilegível é recusado', st == 1 && igual, [st, igual].inspect)
end

if FASE == 4
  # depois da importação, a pessoa escreve de novo pelo caminho NORMAL do Chatwoot (webhook do Instagram)
  ig = Inbox.find_by(name: 'ig')
  hist = Conversation.where(inbox_id: ig.id).where("additional_attributes @> ?::jsonb", { meta_conversation_id: 'cv_ig_novo' }.to_json).first
  ActiveJob::Base.queue_adapter = :test
  msg = ->(mid) { { sender: { id: 'ig_novo' }, recipient: { id: ig.channel.instagram_id }, message: { mid: mid, text: 'olá de novo' } }.with_indifferent_access }
  Messages::Instagram::MessageBuilder.new(msg.call('ig_m1'), ig).perform # mesma mensagem que já importamos: não duplica
  confere('NOVA: mensagem já importada (mesmo mid) chegando pelo webhook NÃO duplica', Message.where(source_id: 'ig_m1').count == 1)
  Messages::Instagram::MessageBuilder.new(msg.call('mid_nova_1'), ig).perform
  nova = Message.find_by(source_id: 'mid_nova_1')
  confere('NOVA: mensagem nova do mesmo contato cai no MESMO contato', nova && nova.conversation.contact_id == hist.contact_id, nova&.conversation&.contact_id.inspect)
  confere('NOVA: ...numa conversa VIVA nova (aberta), não dentro do histórico', nova && nova.conversation_id != hist.id && nova.conversation.status == 'open')
  confere('NOVA: o histórico continua resolvido e intocado', hist.reload.status == 'resolved' && hist.messages.count == 5)
end

if FASE == 5
  # desfazer: com o registro de ids das fases 1 e 2 (e depois da fase 4, em que a pessoa já escreveu de novo)
  ENV['MODO'] = 'desfazer'
  ENV['REGISTRO'] = File.join(TRAB, 'registro.jsonl')
  ENV.delete('GRAVAR')
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count] }
  antes = contagem.call
  hist_antes = Conversation.where('COALESCE(jsonb_exists(additional_attributes, ?), false)', 'meta_conversation_id').count
  confere('há 7 conversas de histórico antes de desfazer', hist_antes == 7, hist_antes.to_s)
  confere('há 6 anexos (5 + o completado) e 6 blobs antes de desfazer', Attachment.count == 6 && ActiveStorage::Blob.count == 6, "#{Attachment.count} #{ActiveStorage::Blob.count}")
  arquivos = -> { Dir[File.join(ActiveStorage::Blob.service.root.to_s, '**', '*')].select { |f| File.file?(f) }.size }
  confere('os 6 arquivos estão em disco', arquivos.call == 6, arquivos.call.to_s)
  # a equipe já usou uma conversa (responsável): o desfazer a mantém, mas tira a mídia e devolve os rótulos
  usada = Conversation.where('additional_attributes @> ?::jsonb', { meta_conversation_id: 'cv_ig_midia' }.to_json).first
  usada.update_columns(assignee_id: User.first.id)
  begin
    load File.join(DIR, 'importar-historico-social.rb')
  rescue SystemExit
    nil
  end
  confere('DESFAZER em seco não apagou nada (nem mídia)', contagem.call == antes && Attachment.count == 6 && ActiveStorage::Blob.count == 6 && arquivos.call == 6)
  ENV['GRAVAR'] = '1'
  limpar_constantes
  begin
    load File.join(DIR, 'importar-historico-social.rb')
  rescue SystemExit
    nil
  end
  confere('DESFAZER: só sobrou a conversa que a equipe já tinha usado', Conversation.where('COALESCE(jsonb_exists(additional_attributes, ?), false)', 'meta_conversation_id').pluck(:id) == [usada.id])
  confere('DESFAZER: apagou os anexos, os vínculos, os blobs E os arquivos em disco', Attachment.none? && ActiveStorage::Attachment.none? && ActiveStorage::Blob.none? && arquivos.call.zero?, "#{Attachment.count} #{ActiveStorage::Attachment.count} #{ActiveStorage::Blob.count} #{arquivos.call}")
  restaurada = Message.where(source_id: %w[mm1 mm2 mm3 mm7]).index_by(&:source_id)
  confere('DESFAZER: nas mensagens que ficaram, os rótulos voltaram e o texto guardado saiu', restaurada['mm1'].content == "segue o exame\n[imagem]\n[arquivo]" && restaurada['mm2'].content == '[áudio]' && restaurada['mm3'].content == '[imagem]' && restaurada['mm7'].content == '[vídeo]' && restaurada.values.none? { |m| m.additional_attributes.key?('hist_conteudo_original') }, restaurada.transform_values(&:content).inspect)
  confere('DESFAZER: mensagens importadas saíram', Message.where(source_id: %w[ig_m1 ig_m2 ig_m3 ig_m4 ig_m0 ig_v1 ig_v2 fbn_1 fbj_1 fbe_1]).none?)
  confere('DESFAZER: mensagens VIVAS ficaram (a velha da semeadura e a que chegou na fase 4)', Message.where(source_id: %w[mid_live mid_nova_1]).count == 2)
  confere('DESFAZER: contato criado SEM conversa viva saiu (Messenger novo)', Contact.where(name: 'Maria do Messenger').none?)
  confere('DESFAZER: contato que já tem conversa viva ficou (Instagram novo que voltou a escrever)', Contact.where(name: 'Paciente A Nome Real').count == 1)
  confere('DESFAZER: nome corrigido do John Doe fica (nome certo não volta a John Doe)', Contact.where(name: 'Joana Nome Real').count == 1)
  confere('DESFAZER: só a etiqueta da conversa mantida sobrou', ActsAsTaggableOn::Tagging.joins(:tag).where(tags: { name: 'historico' }, taggable_type: 'Conversation').count == 1)
end

puts "RESULTADO FASE #{FASE}: #{$falhas.zero? ? 'TUDO PASSOU' : "#{$falhas} FALHA(S)"}"
exit($falhas.zero? ? 0 : 1)
