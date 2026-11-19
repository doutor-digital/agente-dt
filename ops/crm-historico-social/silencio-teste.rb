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
    $conta[:http_externo] += 1 if $medindo
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
  fixtures = {
    'instagram' => {
      'conversas' => [
        { 'id' => 'cv_ig_novo', 'participants' => part.call(pagina_ig, 'ig_novo', usuario: 'paciente_a'), 'messages' => msgs_ig_novo },
        { 'id' => 'cv_ig_vivo', 'participants' => part.call(pagina_ig, 'ig_vivo', usuario: 'vivo'), 'messages' => msgs_ig_vivo },
        { 'id' => 'cv_ig_ja', 'participants' => part.call(pagina_ig, 'ig_vivo', usuario: 'vivo'), 'messages' => msgs_ig_tudo_ja_existe }
      ],
      'perfis' => { 'ig_novo' => { 'name' => 'Paciente A Nome Real', 'username' => 'paciente_a' } }
    },
    'messenger' => {
      'conversas' => [
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
  ENV['CORTE'] = (AGORA - 120).iso8601
  ENV['RITMO'] = '0'
  ENV.delete('GRAVAR')
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  confere('SECO não escreveu nada no banco', contagem.call == base, contagem.call.inspect)
  confere('SECO não disparou nada', $conta.values.sum.zero?, $conta.inspect)

  # ── gravando ──
  Object.send(:remove_const, :GRAVAR)
  Object.send(:remove_const, :CAIXAS)
  Object.send(:remove_const, :CORTE)
  %i[LIMITE RITMO INICIO FIXTURES].each { |k| Object.send(:remove_const, k) }
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
  confere('5 conversas de histórico nasceram (ig_novo, ig_vivo, fb_novo, fb_jd, fb_ed)', hist.size == 5, hist.size.to_s)
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
  confere('IG novo: sem anexo gravado (nada baixado)', ms.all? { |m| m.attachments.none? })
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
  ENV['FIXTURES'] = FIX
  ENV['GRAVAR'] = '1'
  ENV['RITMO'] = '0'
  ig = Inbox.find_by(name: 'ig')
  fb = Inbox.find_by(name: 'fb')
  ENV['CAIXAS'] = "#{ig.id},#{fb.id}"
  ENV['CORTE'] = (AGORA - 120).iso8601
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  confere('IDEMPOTENTE: 2ª rodada não criou nem uma linha', contagem.call == antes, "#{antes} -> #{contagem.call}")
  confere('IDEMPOTENTE: 2ª rodada também em silêncio', $conta.values.sum.zero?, $conta.inspect)
  # a Meta devolve mais uma mensagem antiga numa conversa já importada: entra NA MESMA conversa de histórico
  j = JSON.parse(File.read(FIX))
  j['instagram']['conversas'][0]['messages'] << { 'id' => 'ig_m0', 'created_time' => (AGORA - (4000 * 60)).strftime('%Y-%m-%dT%H:%M:%S+0000'), 'from' => { 'id' => 'ig_novo' }, 'message' => 'mais antiga ainda' }
  File.write(FIX, j.to_json)
  Object.send(:remove_const, :GRAVAR)
  Object.send(:remove_const, :CAIXAS)
  Object.send(:remove_const, :CORTE)
  %i[LIMITE RITMO INICIO FIXTURES].each { |k| Object.send(:remove_const, k) }
  medir { load File.join(DIR, 'importar-historico-social.rb') }
  c_ig = Conversation.where("additional_attributes @> ?::jsonb", { meta_conversation_id: 'cv_ig_novo' }.to_json).to_a
  confere('mensagem velha que apareceu depois entra na MESMA conversa (1 conversa, 5 mensagens)', c_ig.size == 1 && c_ig.first.messages.count == 5, c_ig.map { |c| c.messages.count }.inspect)
  confere('...e a conversa passa a começar na mensagem mais antiga', c_ig.first.created_at.to_i == (AGORA - 4000 * 60).to_i)
  confere('...em silêncio', $conta.values.sum.zero?, $conta.inspect)
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
  confere('NOMES: silêncio total (eventos, jobs, HTTP, e-mail)', $conta.values.sum.zero?, $conta.inspect)
  confere('NOMES: conversa do contato intacta (last_activity_at, updated_at, etc.)', foto_viva(conv) == foto && conv.updated_at.to_f == upd)
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

puts "RESULTADO FASE #{FASE}: #{$falhas.zero? ? 'TUDO PASSOU' : "#{$falhas} FALHA(S)"}"
exit($falhas.zero? ? 0 : 1)
