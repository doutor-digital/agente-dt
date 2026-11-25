# frozen_string_literal: true

# PROVA DE SILÊNCIO da importação do histórico da KOMMO — roda só dentro do testar-silencio.sh, numa instalação DESCARTÁVEL do Chatwoot (banco
# vazio, sem dado de paciente, sem acesso à produção). Monta uma conta com webhook + automação nativa («sair» -> etiqueta) ligados, mede o que
# dispara numa criação NORMAL de mensagem (controle positivo: tem de dar > 0), roda a importação de verdade (importar-kommo-historico.rb com um
# arquivo de cartões de mentira) e confere que NADA disparou. Depois prova que o paciente que escreve pelo caminho normal do WhatsApp Cloud cai
# no MESMO contato e na conversa importada.
#   FASE=1 semeia, controle, seco, importa, confere   FASE=2 re-rodada (idempotência, nada da equipe sobrescrito)
#   FASE=3 o paciente escreve (WhatsApp Cloud)       FASE=4 desfazer       FASE=5 recusas
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
ARQ = File.join(TRAB, 'kommo.jsonl')
AGORA = Time.now.utc.change(usec: 0)
T = ->(dias_atras, h = 12) { (AGORA - (dias_atras * 86_400) + (h * 60)).to_i }

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

def silencio?
  $conta.values.sum.zero?
end

def medir
  $conta.clear
  $medindo = true
  yield
ensure
  $medindo = false
end

def limpar_constantes
  %i[GRAVAR ERROS_DE_PARAMETRO CONTA_ID CAIXA_ID ARQUIVO LIMITE].each { |k| Object.send(:remove_const, k) if Object.const_defined?(k) }
end

def rodar_importador(env = {})
  limpar_constantes
  ENV.update(env.transform_keys(&:to_s).transform_values { |v| v.nil? ? nil : v.to_s })
  load File.join(DIR, 'importar-kommo-historico.rb')
  0
rescue SystemExit => e
  e.status
end

def foto_viva(conv)
  conv.reload
  [conv.last_activity_at.to_f, conv.updated_at.to_f, conv.status, conv.assignee_id, conv.messages.count, conv.label_list.sort, conv.priority, conv.waiting_since, conv.agent_last_seen_at.to_f]
end

def cartao(lead, extra = {})
  { 'tipo' => 'cartao', 'v' => 1, 'lead_id' => lead, 'contato_id' => lead + 5000, 'nome' => "Paciente #{lead}", 'telefone' => '5547991230001', 'funil_kommo' => 'COMERCIAL', 'etapa_kommo' => 'AGENDADO',
    'aberto' => true, 'criado_em' => T.call(40), 'atualizado_em' => T.call(3), 'fechado_em' => nil, 'atributos' => { 'funil' => 'Comercial', 'etapa' => 'Agendado', 'kommo_lead_id' => lead },
    'etiquetas' => ['historico'], 'nota' => "📥 Histórico da Kommo — cartão ##{lead}\nResponsável: Camily", 'mensagens' => [] }.merge(extra)
end

def msg(id, dias, entrada, texto)
  { 'id' => id, 'em' => T.call(dias), 'entrada' => entrada, 'texto' => texto }
end

CONTA_DE_TESTE = 'Timbó de teste'
def conta_do_teste
  Account.find_by!(name: CONTA_DE_TESTE)
end

TELEFONES = { novo_a: '5547991230001', novo_b: '5547991230002', fixo: '554733330003', sem_caixa: '5547991230004', vazio_sem9: '554791230005', viva: '5547991230006' }.freeze

if FASE == 1
  # ── semeia ──
  ActiveJob::Base.queue_adapter = :test
  Channel::Whatsapp.skip_callback(:create, :after, :sync_templates, raise: false)
  Channel::Whatsapp.skip_callback(:commit, :after, :setup_webhooks, raise: false)
  conta = Account.create!(name: CONTA_DE_TESTE)
  Account.create!(name: 'Sem caixa')
  agente = User.new(name: 'Agente', email: 'agente@teste.invalid', password: 'Teste1234!x', password_confirmation: 'Teste1234!x')
  agente.skip_confirmation!
  agente.save!
  AccountUser.create!(account: conta, user: agente, role: :administrator)
  ch = Channel::Whatsapp.new(account: conta, phone_number: '+554784172442', provider: 'whatsapp_cloud', provider_config: { 'api_key' => 'x', 'phone_number_id' => '1', 'business_account_id' => '2' })
  ch.save!(validate: false)
  caixa = Inbox.create!(account: conta, channel: ch, name: 'wa', lock_to_single_conversation: true)
  InboxMember.create!(inbox: caixa, user: agente)
  %w[historico perdido-sem-interesse quente anuncio alta pendente-de-revisao sair].each { |t| Label.create!(account: conta, title: t) }
  ActsAsTaggableOn::Tag.find_or_create_by!(name: 'historico')
  defs = {
    'etapa' => [6, ['Novo lead', 'Sofia qualifica', 'Agendado', 'Confirmado', 'Compareceu', 'Fechou', 'Pós-consulta', 'Perdido']],
    'funil' => [6, %w[Comercial Tratamento]], 'etapa_tratamento' => [6, ['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado']],
    'data_consulta' => [5, []], 'hora_consulta' => [0, []], 'situacao_consulta' => [6, ['Agendado', 'Confirmado', 'Atendido', 'Não compareceu']],
    'qualificacao' => [6, %w[Quente Morno Frio]], 'motivo_nao_agendamento' => [6, ['Sem interesse', 'Plano de saúde', 'Outra cidade']], 'retomar_em' => [5, []]
  }
  defs.each { |k, (tipo, valores)| CustomAttributeDefinition.create!(account: conta, attribute_display_name: k, attribute_key: k, attribute_model: :conversation_attribute, attribute_display_type: tipo, attribute_values: valores) }
  Webhook.create!(account: conta, url: 'http://webhook.invalid/x', subscriptions: %w[conversation_updated message_created conversation_created conversation_status_changed])
  AutomationRule.create!(account: conta, name: 'sair', event_name: 'message_created', active: true,
                         conditions: [{ attribute_key: 'content', filter_operator: 'contains', values: ['sair'], query_operator: nil }], actions: [{ action_name: 'add_label', action_params: ['sair'] }])

  # pacientes que JÁ existem na caixa (nasceram pelo caminho normal) — a importação os reaproveita
  mk = lambda do |src, nome, phone|
    ci = ContactInboxWithContactBuilder.new(source_id: src, inbox: caixa, contact_attributes: { name: nome, phone_number: phone }).perform
    [ci.contact, ci]
  end
  ct_vazio, = mk.call('554791230005', 'Existente sem 9', '+554791230005') # no CRM SEM o 9; o cartão vem COM o 9
  ct_viva, ci_viva = mk.call('5547991230006', 'Já escreveu', '+5547991230006')
  conv_viva = Conversation.create!(account: conta, inbox: caixa, contact: ct_viva, contact_inbox: ci_viva)
  conv_viva.messages.create!(account: conta, inbox: caixa, message_type: :incoming, content: 'oi, sou eu', source_id: 'wamid.viva', sender: ct_viva)
  ct_sem_caixa = Contact.create!(account: conta, name: 'Existe sem caixa', phone_number: '+5547991230004')
  conv_viva.update_columns(last_activity_at: AGORA - 120)
  Sidekiq.redis(&:flushdb)

  # ── controle positivo: a criação NORMAL de uma mensagem com «sair» DEVE mexer em tudo ──
  ActiveJob::Base.queue_adapter = :inline
  controle = Conversation.create!(account: conta, inbox: caixa, contact: ct_vazio, contact_inbox: ct_vazio.contact_inboxes.first)
  medir { controle.messages.create!(account: conta, inbox: caixa, message_type: :incoming, content: 'quero sair da lista', source_id: 'wamid.controle', sender: ct_vazio) }
  puts "controle (criação normal): #{$conta.sort.map { |k, v| "#{k}=#{v}" }.join(' ')}"
  confere('controle positivo: o medidor ENXERGA eventos do Chatwoot na criação normal', $conta[:eventos_chatwoot].positive?)
  confere('controle positivo: o medidor enxerga jobs na criação normal', ($conta[:jobs_activejob] + $conta[:jobs_sidekiq]).positive?)
  confere('controle positivo: a automação nativa REALMENTE reagiu (etiqueta sair)', controle.reload.label_list.include?('sair'), controle.label_list.inspect)
  controle.destroy!

  vivas = { viva: conv_viva }
  fotos_antes = vivas.transform_values { |c| foto_viva(c) }
  notif_antes = Notification.count
  reporting_antes = ReportingEvent.count

  # ── o arquivo do exportador (cartões de mentira) ──
  linhas = [
    { 'tipo' => 'cabecalho', 'v' => 1, 'unidade' => 'doutor-hernia-timbo', 'gerado_em' => AGORA.to_i, 'fechados_desde' => T.call(180) },
    # A: aberto, Agendado, paciente novo, conversa com «sair/urgente» (as automações NÃO podem reagir)
    cartao(1001, 'mensagens' => [msg('a1', 20, true, 'oi, quero agendar'), msg('a2', 20, false, 'Claro! Qual a sua queixa?'), msg('a3', 19, true, 'dor forte, é urgente, quero parar de sentir. sair de casa dói'), msg('a4', 3, false, 'Confirmado para sexta')],
                 'atributos' => { 'funil' => 'Comercial', 'etapa' => 'Agendado', 'data_consulta' => '2026-11-27', 'hora_consulta' => '10:30', 'situacao_consulta' => 'Agendado', 'qualificacao' => 'Quente', 'kommo_lead_id' => 1001, 'origem' => 'Meta-Instagram' },
                 'etiquetas' => %w[historico quente anuncio etiqueta-que-a-conta-nao-tem]),
    # B: perdido há 2 meses, paciente novo
    cartao(1002, 'telefone' => TELEFONES[:novo_b], 'aberto' => false, 'etapa_kommo' => 'PERDIDO', 'fechado_em' => T.call(60), 'atualizado_em' => T.call(60),
                 'atributos' => { 'funil' => 'Comercial', 'etapa' => 'Perdido', 'motivo_nao_agendamento' => 'Sem interesse', 'kommo_lead_id' => 1002 }, 'etiquetas' => %w[historico perdido-sem-interesse],
                 'mensagens' => [msg('b1', 70, true, 'quanto custa?'), msg('b2', 70, false, 'R$ 250 a avaliação')]),
    # C: MESMO telefone do A, funil Tratamento (um contato, duas conversas)
    cartao(1003, 'funil_kommo' => 'TRATAMENTO', 'etapa_kommo' => 'EM TRATAMENTO', 'atributos' => { 'funil' => 'Tratamento', 'etapa_tratamento' => 'Em tratamento', 'kommo_lead_id' => 1003 }, 'atualizado_em' => T.call(1),
                 'mensagens' => [msg('c1', 2, false, 'Sua sessão é amanhã')]),
    # D: EM ESPERA (sem coluna): etapa vazia + conferir-etapa (a conta ainda NÃO tem a etiqueta: a importação a cria)
    cartao(1004, 'telefone' => TELEFONES[:fixo], 'etapa_kommo' => 'EM ESPERA', 'atributos' => { 'funil' => 'Comercial', 'retomar_em' => '2026-12-01', 'kommo_lead_id' => 1004 }, 'etiquetas' => %w[historico conferir-etapa]),
    # G: existe no CRM sem o 9, o cartão traz com o 9 (mesmo celular)
    cartao(1005, 'telefone' => '5547991230005', 'mensagens' => [msg('g1', 5, true, 'oi')]),
    # H: já escreveu pelo WhatsApp (conversa viva): o histórico NÃO pode roubar a próxima mensagem
    cartao(1006, 'telefone' => TELEFONES[:viva], 'mensagens' => [msg('h1', 9, true, 'bom dia')]),
    # I: contato existe sem caixa
    cartao(1007, 'telefone' => TELEFONES[:sem_caixa]),
    # J: valor fora da lista e atributo sem definição são descartados; origem passa
    cartao(1008, 'telefone' => '5547991230007', 'atributos' => { 'funil' => 'Comercial', 'etapa' => 'Etapa Inventada', 'foo_bar' => 'x', 'origem' => 'Indicação', 'valor_fechado' => 4500, 'kommo_lead_id' => 1008 }),
    # E: sem telefone (recusado, contado)  F: lixo
    cartao(1009, 'telefone' => nil),
    # K: SEGUNDO cartão do paciente que já tem conversa viva: também vai pelo HI.<número> (nunca pelo contact_inbox da viva)
    cartao(1010, 'telefone' => TELEFONES[:viva], 'aberto' => false, 'etapa_kommo' => 'PERDIDO', 'fechado_em' => T.call(90), 'atualizado_em' => T.call(90), 'atributos' => { 'funil' => 'Comercial', 'etapa' => 'Perdido', 'kommo_lead_id' => 1010 })
  ].map(&:to_json)
  linhas << '{isto não é json'
  File.write(ARQ, linhas.join("\n"))

  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count, Label.count] }
  base = contagem.call
  medir { rodar_importador(GRAVAR: nil, ARQUIVO: ARQ, CONTA: conta.id, CAIXA: nil, LIMITE_CARTOES: nil) }
  confere('SECO não escreveu nada no banco (nem a etiqueta conferir-etapa)', contagem.call == base, contagem.call.inspect)
  confere('SECO não disparou nada', silencio?, $conta.inspect)
  rs = $ultimo_resumo
  confere('SECO conta: 10 cartões no arquivo (+1 linha que nem é JSON), 1 recusado por falta de telefone, 9 válidos', rs[:cartoes_no_arquivo] == 10 && rs[:linha_recusada_sem_telefone] == 1 && rs[:linha_recusada_json] == 1 && rs[:cartoes_novos] == 9, rs.inspect)
  confere('SECO conta contatos novos / reaproveitados / com conversa viva', rs[:contatos_novos] == 4 && rs[:contatos_reaproveitados] == 2 && rs[:contatos_com_conversa_viva_no_crm] == 1 && rs[:cartoes_do_mesmo_telefone] == 2, rs.inspect)

  # ── gravando (a importação de VERDADE, medida) ──
  medir { rodar_importador(GRAVAR: '1', ARQUIVO: ARQ, CONTA: conta.id) }
  confere('SILÊNCIO: zero eventos do Chatwoot (webhook/automação/notificação nascem deles)', $conta[:eventos_chatwoot].zero?, $conta.inspect)
  confere('SILÊNCIO: zero jobs enfileirados nem executados (Sidekiq/ActiveJob)', ($conta[:jobs_activejob] + $conta[:jobs_sidekiq] + $conta[:jobs_executados]).zero?, $conta.inspect)
  confere('SILÊNCIO: zero HTTP para fora (webhook do agente, Meta, Kommo)', $conta[:http_externo].zero?, $conta.inspect)
  confere('SILÊNCIO: zero e-mail', $conta[:emails].zero?)
  hist = Conversation.where(account_id: conta.id).select { |c| c.additional_attributes.key?('kommo_lead_id') }.sort_by(&:id)
  por_lead = hist.index_by { |c| c.additional_attributes['kommo_lead_id'] }

  confere('os 9 cartões válidos viraram conversa (o sem telefone e o JSON ruim não)', hist.size == 9 && por_lead.keys.sort == [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1010], por_lead.keys.sort.inspect)
  confere('todas RESOLVIDAS, sem responsável, sem prioridade, sem espera', hist.all? { |c| c.resolved? && c.assignee_id.nil? && c.priority.nil? && c.waiting_since.nil? })
  confere('todas com a marca de origem kommo e a etiqueta historico (a trava da régua e do CAPI)', hist.all? { |c| c.additional_attributes['origem_historico'] == 'kommo' && c.reload.label_list.include?('historico') })
  confere('etiquetas: as da conta entram, a que a conta não tem some; a automação não pôs nada (sair)', por_lead[1001].label_list.sort == %w[anuncio historico quente] && !hist.any? { |c| c.label_list.include?('sair') }, por_lead[1001].label_list.inspect)
  confere('etiqueta conferir-etapa foi CRIADA na conta e vale no cartão sem coluna', Label.exists?(account_id: conta.id, title: 'conferir-etapa') && por_lead[1004].label_list.sort == %w[conferir-etapa historico])
  confere('display_id veio do banco', hist.all? { |c| c.display_id.to_i.positive? })

  a = por_lead[1001]
  ms = a.messages.where(private: false).order(:created_at, :id).to_a
  confere('A: 4 mensagens na ordem, data/hora ORIGINAL', ms.map(&:source_id) == %w[kommo:1001:a1 kommo:1001:a2 kommo:1001:a3 kommo:1001:a4] && ms.first.created_at.to_i == T.call(20) && ms.last.created_at.to_i == T.call(3), ms.map(&:source_id).inspect)
  confere('A: direção (recebida/enviada); enviada sem remetente e marcada externa; recebida com o contato', ms.map(&:message_type) == %w[incoming outgoing incoming outgoing] && ms[0].sender == a.contact && ms[1].sender.nil? && ms[1].content_attributes['external_echo'] == true)
  confere('A: palavras de automação (sair/urgente/parar) NÃO acionaram etiqueta, nota nem prioridade', !a.label_list.include?('sair') && a.priority.nil?)
  nota = a.messages.find_by(private: true)
  confere('A: a NOTA-resumo é privada, abre a conversa (antes da 1ª mensagem) e tem o texto do exportador', nota && nota.message_type == 'outgoing' && nota.content.include?('Histórico da Kommo') && nota.created_at < ms.first.created_at)
  confere('A: atributos do CRM (etapa, funil, consulta, qualificação) e origem; a marca do cartão fica na conversa e não nos atributos', a.custom_attributes.slice('funil', 'etapa', 'data_consulta', 'hora_consulta', 'situacao_consulta', 'qualificacao', 'origem') == { 'funil' => 'Comercial', 'etapa' => 'Agendado', 'data_consulta' => '2026-11-27', 'hora_consulta' => '10:30', 'situacao_consulta' => 'Agendado', 'qualificacao' => 'Quente', 'origem' => 'Meta-Instagram' } && !a.custom_attributes.key?('kommo_lead_id'), a.custom_attributes.inspect)
  confere('A: conversa criada na data do cartão e com a última atividade = a da última mudança (não a de hoje)', a.created_at.to_i == T.call(40) && a.last_activity_at.to_i == T.call(3))
  confere('A: o contato é novo, com o telefone em formato E.164 e o source_id só dígitos (o do WhatsApp Cloud)', a.contact.phone_number == '+5547991230001' && a.contact_inbox.source_id == '5547991230001' && a.contact.name == 'Paciente 1001')
  c = por_lead[1003]
  confere('A e C: o MESMO telefone é UM contato com duas conversas; a de tratamento (a mais viva) tem o MAIOR id', a.contact_id == c.contact_id && a.contact_inbox_id == c.contact_inbox_id && c.id > a.id)
  confere('C: Tratamento tem etapa_tratamento e NÃO tem etapa comercial', c.custom_attributes['etapa_tratamento'] == 'Em tratamento' && !c.custom_attributes.key?('etapa'))
  b = por_lead[1002]
  confere('B: perdido há 2 meses entra Perdido com motivo e etiqueta perdido-*', b.custom_attributes['etapa'] == 'Perdido' && b.custom_attributes['motivo_nao_agendamento'] == 'Sem interesse' && b.label_list.include?('perdido-sem-interesse'))
  confere('B: vem ANTES dos abertos na ordem de gravação (fechados primeiro)', b.id < a.id)
  d = por_lead[1004]
  confere('D: EM ESPERA sem coluna: etapa vazia, retomar_em preenchido', !d.custom_attributes.key?('etapa') && d.custom_attributes['retomar_em'] == '2026-12-01')
  j = por_lead[1008]
  confere('J: valor fora da lista e atributo sem definição descartados; origem e valor_fechado (sem definição, permitidos) ficam', !j.custom_attributes.key?('etapa') && !j.custom_attributes.key?('foo_bar') && j.custom_attributes['origem'] == 'Indicação' && j.custom_attributes['valor_fechado'] == 4500, j.custom_attributes.inspect)
  g = por_lead[1005]
  confere('G: existia SEM o 9; o cartão veio COM o 9 e caiu no MESMO contato e contact_inbox (nenhum contato duplicado)', g.contact.name == 'Existente sem 9' && g.contact_inbox.source_id == '554791230005' && Contact.where(account_id: conta.id).where("phone_number LIKE '+554791230005' OR phone_number LIKE '+5547991230005'").count == 1)
  h = por_lead[1006]
  confere('H: paciente que JÁ escreveu: o histórico vai por um contact_inbox próprio HI.<número> (não rouba a próxima mensagem)', h.contact_id == conv_viva.contact_id && h.contact_inbox.source_id == 'HI.5547991230006' && h.contact_inbox_id != conv_viva.contact_inbox_id)
  k10 = por_lead[1010]
  confere('K: o 2º cartão do paciente com conversa viva também vai pelo HI.<número> (e é o MESMO contact_inbox do H)', k10.contact_inbox.source_id == 'HI.5547991230006' && k10.contact_inbox_id == h.contact_inbox_id && ContactInbox.where(inbox_id: caixa.id, source_id: 'HI.5547991230006').count == 1)
  confere('H: a conversa VIVA ficou idêntica', foto_viva(conv_viva) == fotos_antes[:viva], "#{fotos_antes[:viva]} != #{foto_viva(conv_viva)}")
  i7 = por_lead[1007]
  confere('I: contato existente sem caixa é reaproveitado (nenhum duplicado) e ganha o contact_inbox', i7.contact.name == 'Existe sem caixa' && i7.contact_inbox.source_id == '5547991230004' && Contact.where(account_id: conta.id, phone_number: '+5547991230004').count == 1)
  puts "durante a importação (o que a importação REAL disparou): #{$conta.inspect}"

  confere('SILÊNCIO: zero notificação ao atendente', Notification.count == 0)
  confere('SILÊNCIO: zero evento de relatório', ReportingEvent.count == 0)
  # renderização: o que o painel, a API e o webhook montam a partir dessas linhas não pode quebrar
  hist.each do |cv|
    cv.messages.each { |m| m.push_event_data; m.webhook_data }
    cv.push_event_data
    cv.webhook_data
    cv.contact.push_event_data
  end
  confere('renderização (push_event_data/webhook_data) sem erro em conversa, nota, mensagem e contato', true)
end

if FASE == 2
  conta = conta_do_teste
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count] }
  a = Conversation.where(account_id: conta.id).detect { |c| c.additional_attributes['kommo_lead_id'] == 1001 }
  antes = contagem.call
  # a equipe mexeu na conversa A (etapa trocada) e a Kommo ganhou uma mensagem nova e a qualificação que faltava
  a.update!(custom_attributes: a.custom_attributes.merge('etapa' => 'Compareceu'))
  linhas = File.readlines(ARQ).map { |l| JSON.parse(l) rescue l }
  alvo = linhas.detect { |l| l.is_a?(Hash) && l['lead_id'] == 1001 }
  alvo['mensagens'] << msg('a5', 1, true, 'cheguei na clínica')
  alvo['atributos'] = alvo['atributos'].merge('etapa' => 'Agendado', 'retomar_em' => '2026-12-05')
  File.write(ARQ, linhas.map { |l| l.is_a?(Hash) ? l.to_json : l }.join("\n"))
  medir { rodar_importador(GRAVAR: '1', ARQUIVO: ARQ, CONTA: conta.id, CAIXA: nil) }
  rs = $ultimo_resumo
  d = contagem.call
  confere('IDEMPOTENTE: 2ª rodada não criou contato, contact_inbox, conversa nem etiqueta; só a 1 mensagem nova (+0 notas)', d[0..2] == antes[0..2] && d[4] == antes[4] && d[3] == antes[3] + 1, "#{antes} -> #{d}")
  confere('IDEMPOTENTE: o resumo diz 9 já importados, 0 novos, 1 mensagem gravada', rs[:cartoes_ja_importados] == 9 && rs[:cartoes_novos].zero? && rs[:mensagens_gravadas] == 1 && rs[:notas_gravadas].zero?, rs.inspect)
  confere('IDEMPOTENTE: em silêncio', silencio?, $conta.inspect)
  a.reload
  confere('o que a EQUIPE mexeu não é sobrescrito (etapa continua Compareceu) e o que estava vazio é preenchido (retomar_em)', a.custom_attributes['etapa'] == 'Compareceu' && a.custom_attributes['retomar_em'] == '2026-12-05', a.custom_attributes.inspect)
  confere('a mensagem nova entrou UMA vez, no fim, e a última atividade avançou', a.messages.where(private: false).order(:created_at, :id).last.source_id == 'kommo:1001:a5' && a.messages.where(source_id: 'kommo:1001:a5').count == 1 && a.last_activity_at.to_i == T.call(1))
  # terceira rodada: nada
  medir { rodar_importador(GRAVAR: '1', ARQUIVO: ARQ, CONTA: conta.id) }
  confere('3ª rodada: nada novo, nada gravado', contagem.call == d && $ultimo_resumo[:mensagens_gravadas].zero? && silencio?, $ultimo_resumo.inspect)
end

if FASE == 3
  # o paciente escreve pelo CAMINHO NORMAL do WhatsApp Cloud: tem de cair no contato importado e na conversa importada
  ActiveJob::Base.queue_adapter = :test
  conta = conta_do_teste
  caixa = Inbox.find_by!(account_id: conta.id, channel_type: 'Channel::Whatsapp')
  enviar = lambda do |wa_id, texto|
    params = { entry: [{ 'changes' => [{ 'value' => { 'contacts' => [{ 'profile' => { 'name' => 'Nome do WhatsApp' }, 'wa_id' => wa_id }],
                                                      'messages' => [{ 'from' => wa_id, 'id' => "wamid.#{SecureRandom.hex(6)}", 'timestamp' => Time.now.to_i.to_s, 'text' => { 'body' => texto }, 'type' => 'text' }],
                                                      'metadata' => { 'phone_number_id' => '1', 'display_phone_number' => '554784172442' } } }] }] }.with_indifferent_access
    Whatsapp::IncomingMessageWhatsappCloudService.new(inbox: caixa, params: params).perform
  end
  contatos_antes = Contact.where(account_id: conta.id).count
  convs_antes = Conversation.where(account_id: conta.id).count
  # (1) o paciente A/C (celular COM o 9) — duas conversas importadas; a de maior id é a do tratamento
  enviar.call('5547991230001', 'oi, voltei')
  m = Message.find_by(content: 'oi, voltei')
  c = Conversation.where(account_id: conta.id).detect { |x| x.additional_attributes['kommo_lead_id'] == 1003 }
  confere('PACIENTE ESCREVE: caiu no contato importado e na conversa viva do tratamento (a de maior id), sem contato nem conversa nova', m && m.conversation_id == c.id && Contact.where(account_id: conta.id).count == contatos_antes && Conversation.where(account_id: conta.id).count == convs_antes, m&.conversation_id.inspect)
  confere('PACIENTE ESCREVE: a conversa importada REABRIU e carrega a etapa e as etiquetas importadas', c.reload.open? && c.custom_attributes['etapa_tratamento'] == 'Em tratamento' && c.label_list.include?('historico'))
  # (2) o WhatsApp manda o wa_id SEM o 9 (acontece no Brasil): o Chatwoot casa as duas formas
  enviar.call('554791230005', 'bom dia, sem o nove')
  m2 = Message.find_by(content: 'bom dia, sem o nove')
  g = Conversation.where(account_id: conta.id).detect { |x| x.additional_attributes['kommo_lead_id'] == 1005 }
  confere('PACIENTE ESCREVE (wa_id sem o 9): casa com o contato importado e cai na conversa importada', m2 && m2.conversation_id == g.id && Contact.where(account_id: conta.id).count == contatos_antes, m2&.conversation_id.inspect)
  # (3) quem já tinha conversa viva continua na SUA conversa viva, não na do histórico
  enviar.call('5547991230006', 'de novo')
  m3 = Message.find_by(content: 'de novo')
  h = Conversation.where(account_id: conta.id).detect { |x| x.additional_attributes['kommo_lead_id'] == 1006 }
  confere('PACIENTE QUE JÁ TINHA CONVERSA VIVA: a mensagem cai na viva, não no histórico (HI.)', m3 && m3.conversation_id != h.id && !Conversation.find(m3.conversation_id).additional_attributes.key?('kommo_lead_id'), m3&.conversation_id.inspect)
end

if FASE == 4
  registro = File.join(TRAB, 'registro.jsonl')
  conta = conta_do_teste
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count, ActsAsTaggableOn::Tagging.count] }
  antes = contagem.call
  # a equipe já usou duas coisas: reabriu/respondeu a conversa C (o paciente escreveu na fase 3) e pôs uma NOTA no contato do cartão 1007
  nota_contato = Contact.find_by!(account_id: conta.id, phone_number: '+5547991230004')
  Note.create!(account_id: conta.id, contact: nota_contato, user: User.first, content: 'ligar amanhã')
  # re-rodada DEPOIS de o paciente ter escrito (a conversa dele agora é «viva» no contact_inbox principal): não pode nascer HI.<número> à toa nem contato duplicado
  contatos_antes = Contact.where(account_id: conta.id).count
  cis_antes = ContactInbox.count
  rodar_importador(GRAVAR: '1', ARQUIVO: ARQ, CONTA: conta.id, MODO: nil, REGISTRO: nil)
  confere('RE-RODADA depois de o paciente escrever: nenhum contato nem contact_inbox novo', Contact.where(account_id: conta.id).count == contatos_antes && ContactInbox.count == cis_antes, "#{cis_antes} -> #{ContactInbox.count}")
  antes = contagem.call
  st = rodar_importador(GRAVAR: nil, MODO: 'desfazer', REGISTRO: registro, CONTA: conta.id, ARQUIVO: nil)
  confere('DESFAZER em seco não apagou nada', contagem.call == antes && st == 0)
  rodar_importador(GRAVAR: '1', MODO: 'desfazer', REGISTRO: registro, CONTA: conta.id, ARQUIVO: nil)
  restantes = Conversation.where(account_id: conta.id).select { |c| c.additional_attributes.key?('kommo_lead_id') }.map { |c| c.additional_attributes['kommo_lead_id'] }.sort
  confere('DESFAZER: só ficaram as conversas que a equipe/o paciente já usaram (C reaberta, G e a que recebeu mensagem do paciente)', restantes == [1003, 1005], restantes.inspect)
  confere('DESFAZER: as mensagens do histórico saíram e as do paciente ficaram', Message.where('source_id LIKE ?', 'kommo:%').where.not(conversation_id: Conversation.where(account_id: conta.id).pluck(:id)).none? && Message.where(content: ['oi, voltei', 'bom dia, sem o nove', 'de novo']).count == 3)
  confere('DESFAZER: contato que já existia ficou (Existente sem 9, Já escreveu, Existe sem caixa)', %w[Existente\ sem\ 9 Já\ escreveu Existe\ sem\ caixa].all? { |n| Contact.where(account_id: conta.id, name: n).count == 1 })
  confere('DESFAZER: contato com NOTA da equipe fica e a nota não fica órfã', Note.where(contact_id: nota_contato.id).count == 1)
  confere('DESFAZER: contato criado pela importação sem conversa nenhuma saiu (Paciente 1002)', Contact.where(account_id: conta.id, name: 'Paciente 1002').none?)
  confere('DESFAZER: contato criado e ainda com conversa fica (Paciente 1001/1003)', Contact.where(account_id: conta.id, name: 'Paciente 1001').count == 1)
end

if FASE == 5
  contagem = -> { [Contact.count, ContactInbox.count, Conversation.count, Message.count] }
  conta = conta_do_teste
  vazia = Account.find_by!(name: 'Sem caixa')
  api = Inbox.create!(account: conta, channel: Channel::Api.create!(account: conta), name: 'api')
  File.write(File.join(TRAB, 'sem-cabecalho.jsonl'), cartao(1).to_json)
  antes = contagem.call
  rec = lambda do |env|
    r = rodar_importador({ GRAVAR: '1', ARQUIVO: ARQ, CONTA: conta.id, CAIXA: nil, LIMITE_CARTOES: nil, MODO: nil }.merge(env))
    [r, contagem.call == antes]
  end
  st, igual = rec.call(CONTA: vazia.id)
  confere('conta SEM a caixa do WhatsApp: a rodada é RECUSADA e nada é gravado', st == 1 && igual, [st, igual].inspect)
  st, igual = rec.call(CAIXA: api.id)
  confere('caixa que não é WhatsApp (API): recusada', st == 1 && igual, [st, igual].inspect)
  st, igual = rec.call(LIMITE_CARTOES: 0)
  confere('LIMITE_CARTOES=0 é recusado (não vira «sem limite»)', st == 1 && igual, [st, igual].inspect)
  st, igual = rec.call(ARQUIVO: File.join(TRAB, 'nao-existe.jsonl'))
  confere('arquivo inexistente: recusado', st == 1 && igual, [st, igual].inspect)
  st, igual = rec.call(ARQUIVO: File.join(TRAB, 'sem-cabecalho.jsonl'))
  confere('arquivo sem o cabeçalho do exportador: recusado', st == 1 && igual, [st, igual].inspect)
  st, igual = rec.call(LIMITE_CARTOES: 1, GRAVAR: nil)
  confere('LIMITE_CARTOES=1 em seco funciona e conta 1 cartão', st == 0 && igual && $ultimo_resumo[:cartoes_ja_importados].to_i + $ultimo_resumo[:cartoes_novos].to_i == 1, $ultimo_resumo.inspect)
end

puts "RESULTADO FASE #{FASE}: #{$falhas.zero? ? 'TUDO PASSOU' : "#{$falhas} FALHA(S)"}"
exit($falhas.zero? ? 0 : 1)
