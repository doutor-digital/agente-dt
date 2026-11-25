# frozen_string_literal: true

# IMPORTA O HISTÓRICO DA KOMMO (escopo B: cartões abertos + ganhos/perdidos dos últimos 6 meses) para o CRM (Chatwoot) de UMA unidade.
# Roda DENTRO do contêiner `chatwoot_rails` (rails runner), lendo o arquivo JSONL que o exportador (backend: kommo-historico-exportar) deixou na VPS
# — dado de paciente nunca sai dela. Quem chama é o ops/historico-kommo-crm-joao.sh. Só ids e contagens vão para a saída: nunca nome, telefone,
# texto, queixa ou token.
#
# SILÊNCIO (a mesma garantia da importação do Instagram/Messenger, #420): tudo é gravado com insert_all!/update_all, SEM callbacks do Rails. Os
# eventos do Chatwoot (webhook para o agente, automações nativas, notificação, e-mail, ActionCable, Sidekiq) nascem nos `after_*_commit` dos
# modelos; sem callback, não nascem. A prova roda numa instalação descartável: testar-silencio.sh.
#
# O QUE CADA CARTÃO VIRA: um contato (telefone = o MESMO source_id que a caixa do WhatsApp usa, para a próxima mensagem do paciente cair nele) e uma
# conversa RESOLVIDA com a etiqueta `historico`, os atributos do CRM (etapa, funil, consulta…), uma NOTA-resumo privada e as últimas mensagens
# da Kommo. A etiqueta `historico` é a TRAVA que protege o paciente: a régua e o CAPI tratam o que vem com ela como estado inicial.
#
# Variáveis:
#   GRAVAR=1             sem isto é CONFERÊNCIA EM SECO: só lê o arquivo e o banco e conta. NADA é escrito.
#   ARQUIVO=/tmp/...     o JSONL do exportador (obrigatório)
#   CONTA=3              id da conta do Chatwoot (padrão 3 = Doutor Hérnia Timbó)
#   CAIXA=n              id da caixa do WhatsApp (padrão: a ÚNICA caixa Channel::Whatsapp da conta; sem ela a rodada é RECUSADA)
#   LIMITE_CARTOES=n     só os n primeiros cartões do arquivo, na ordem de gravação (n > 0; 0 é recusado)
#   MODO=desfazer        com REGISTRO=arquivo (linhas REG de uma rodada que gravou): desfaz o que ela criou (seco sem GRAVAR=1)
require 'json'
require 'securerandom'
require 'set'
require File.join(ENV['HS_DIR'] || File.dirname(File.expand_path(__FILE__)), 'kommo_historico')

K = KommoHistorico unless defined?(K)
# STDOUT (e não $stdout): sob `rails runner` o $stdout é bufferizado e o acompanhamento só veria o log no fim da rodada
STDOUT.sync = true

GRAVAR = ENV['GRAVAR'] == '1'
ERROS_DE_PARAMETRO = []
CONTA_ID = (ENV['CONTA'] || '3').to_i
CAIXA_ID = ENV['CAIXA'].to_s.empty? ? nil : ENV['CAIXA'].to_i
ARQUIVO = ENV['ARQUIVO'].to_s
LIMITE = begin
  if ENV['LIMITE_CARTOES'].to_s.empty?
    0
  else
    n = Integer(ENV['LIMITE_CARTOES'], 10)
    ERROS_DE_PARAMETRO << 'LIMITE_CARTOES=0 (ou negativo) é recusado: 0 não significa «sem limite» — tire a variável para importar tudo' if n <= 0
    n
  end
rescue ArgumentError
  ERROS_DE_PARAMETRO << 'LIMITE_CARTOES precisa ser um número inteiro'
  0
end

class ErroNosso < StandardError; end

def log(texto)
  STDOUT.puts "LOG #{Time.now.utc.strftime('%H:%M:%S')} #{texto}"
  STDOUT.flush
end

# Registro para desfazer: só ids. Linha `REG {...}` (o ops/*.sh guarda a saída em /root/kit/logs).
def reg(tipo, ids)
  ids.each_slice(2000) { |s| STDOUT.puts "REG #{{ tipo: tipo, ids: s }.to_json}" } unless ids.empty?
end

# Erro sem texto de paciente: o PG imprime a LINHA inteira num NOT NULL; então só classe e SQLSTATE.
def erro_seguro(e)
  causa = e.respond_to?(:cause) ? e.cause : nil
  estado = causa.respond_to?(:result) && causa.result ? causa.result.error_field(PG::PG_DIAG_SQLSTATE) : nil
  base = e.is_a?(ErroNosso) ? e.message : e.class.name
  # a linha do NOSSO código onde estourou (arquivo:número — nunca o texto do erro, que pode trazer dado)
  onde = e.is_a?(ErroNosso) ? nil : e.backtrace&.find { |l| l.include?('importar-kommo-historico') }&.sub(%r{\A.*/}, '')&.sub(/:in .*\z/, '')
  [base, causa && causa.class.name, estado && "sqlstate #{estado}", onde && "em #{onde}"].compact.join(' / ')
end

# ─── desfazer ───────────────────────────────────────────────────────────────────────────────────────────────────────
def desfazer!
  arq = ENV['REGISTRO'].to_s
  raise ErroNosso, 'MODO=desfazer exige REGISTRO=arquivo' if arq.empty? || !File.file?(arq)

  tudo = Hash.new { |h, k| h[k] = [] }
  linhas = 0
  File.foreach(arq) do |l|
    next unless l.start_with?('REG ')

    j = JSON.parse(l.sub('REG ', ''))
    linhas += 1
    tudo[j['tipo']].concat(j['ids']) if j['ids']
  end
  raise ErroNosso, 'o registro não tem nenhuma linha REG (arquivo errado ou rodada que não gravou): nada a desfazer' if linhas.zero?

  convs = tudo['conversas'].uniq
  mensagens_registro = tudo['mensagens'].uniq
  # a conversa só sai se NINGUÉM a usou depois (resolvida, sem responsável, nenhuma mensagem fora do registro). UMA consulta para todas.
  com_mensagem_de_fora = Message.where(conversation_id: convs).where.not(id: mensagens_registro).reorder(nil).distinct.pluck(:conversation_id).to_set
  intocadas = Conversation.where(id: convs).select { |cv| cv.status == 'resolved' && cv.assignee_id.nil? && !com_mensagem_de_fora.include?(cv.id) }.map(&:id)
  mexidas = convs - intocadas
  log "desfazer: conversas criadas=#{convs.size} (intocadas=#{intocadas.size}; as #{mexidas.size} que a equipe já usou — mensagem, reabertura ou responsável — ficam) " \
      "mensagens=#{mensagens_registro.size} contatos=#{tudo['contatos'].uniq.size} contact_inboxes=#{tudo['contact_inboxes'].uniq.size}"
  unless GRAVAR
    log 'SECO: nada foi apagado. Rode com GRAVAR=1 (e --confirmo-apagar) para desfazer.'
    return
  end
  ActiveRecord::Base.transaction do
    msgs = Message.where(conversation_id: intocadas, id: mensagens_registro).delete_all
    tags = ActsAsTaggableOn::Tagging.where(id: tudo['taggings'].uniq, taggable_type: 'Conversation', taggable_id: intocadas).delete_all
    cs = Conversation.where(id: intocadas).delete_all
    cis = tudo['contact_inboxes'].uniq.select { |ci| !Conversation.where(contact_inbox_id: ci).exists? }
    ContactInbox.where(id: cis).delete_all
    # contato que a EQUIPE mexeu (nota, etiqueta, campo, e-mail/identificador) NÃO é apagado: delete_all deixaria as notas órfãs
    cts = []
    editados = 0
    Contact.where(id: tudo['contatos'].uniq).find_each do |ct|
      mexido = Note.where(contact_id: ct.id).exists? || ActsAsTaggableOn::Tagging.where(taggable_type: 'Contact', taggable_id: ct.id).exists? ||
               ct.custom_attributes.present? || ct.email.present? || ct.identifier.present?
      if mexido
        editados += 1
      elsif !ContactInbox.where(contact_id: ct.id).exists? && !Conversation.where(contact_id: ct.id).exists?
        cts << ct.id
      end
    end
    Contact.where(id: cts).delete_all
    log "desfeito: mensagens=#{msgs} taggings=#{tags} conversas=#{cs} contact_inboxes=#{cis.size} contatos=#{cts.size} contatos_mantidos_por_edicao_da_equipe=#{editados}"
  end
end

# ─── importação ─────────────────────────────────────────────────────────────────────────────────────────────────────
def achar_caixa(conta)
  caixas = Inbox.where(account_id: conta.id, channel_type: 'Channel::Whatsapp')
  caixas = caixas.where(id: CAIXA_ID) if CAIXA_ID
  raise ErroNosso, "a conta #{conta.id} ainda NÃO tem a caixa do WhatsApp (vem depois do Kapso): a importação espera a caixa existir, para os contatos casarem com os que ela vai criar" if caixas.none?
  raise ErroNosso, "a conta #{conta.id} tem mais de uma caixa de WhatsApp: diga qual com CAIXA=<id>" if caixas.count > 1

  caixa = caixas.first
  raise ErroNosso, "a caixa #{caixa.id} não é WhatsApp Cloud (provider #{caixa.channel.provider}): o source_id seria outro" unless caixa.channel.provider == 'whatsapp_cloud'

  caixa
end

def garantir_etiqueta(conta, nome)
  return if Label.exists?(account_id: conta.id, title: nome)
  return unless GRAVAR && K::ETIQUETAS_CRIADAS.include?(nome)

  # insert_all!: Label.create! dispara evento de etiqueta (e jobs) — a importação é em silêncio até na etiqueta que cria
  agora = Time.now.utc
  Label.insert_all!([{ account_id: conta.id, title: nome, description: 'Importada da Kommo (histórico)', color: '#8B8D98', show_on_sidebar: false, created_at: agora, updated_at: agora }])
end

def tag_da(nome)
  ActsAsTaggableOn::Tag.find_or_create_by!(name: nome)
end

# O contato desta pessoa na caixa → { contato_id:, ci_id:, situacao: }
#  - já há contact_inbox com o telefone (qualquer formato do Brasil: com e sem o 9) → o reaproveita;
#  - se ELE já tem conversa viva (que não é nossa), o histórico vai por um contact_inbox próprio «HI.<número>» e não rouba a próxima mensagem do paciente;
#  - senão o contato pode existir sem caixa (mesmo telefone) → reaproveita o contato e cria o contact_inbox;
#  - senão nasce contato + contact_inbox, com o source_id no formato do WhatsApp Cloud (só dígitos, com DDI).
# `cache` (por telefone) faz os cartões do MESMO telefone na rodada caírem no mesmo contato.
def achar_contato(inbox, linha, cache)
  variantes = K.variantes_do_fone(linha[:telefone])
  canonico = variantes.first
  return cache[canonico].merge(repetido: true) if cache.key?(canonico) # a situação ORIGINAL do telefone segue valendo (conversa viva continua indo para o «HI.»)

  ci = ContactInbox.where(inbox_id: inbox.id, source_id: variantes).order(:id).first
  if ci
    viva = Conversation.where(contact_inbox_id: ci.id).where('NOT COALESCE(jsonb_exists(additional_attributes, ?), false)', K::MARCA_CONVERSA).exists?
    return cache[canonico] = { contato_id: ci.contact_id, ci_id: viva ? nil : ci.id, situacao: viva ? :com_conversa_viva : :reaproveitado }
  end
  ct = Contact.where(account_id: inbox.account_id, phone_number: variantes.map { |v| "+#{v}" }).order(:id).first
  return cache[canonico] = { contato_id: ct.id, ci_id: nil, situacao: :contato_sem_caixa } if ct

  cache[canonico] = { contato_id: nil, ci_id: nil, situacao: :novo }
end

def contagem_por_valor(c, prefixo, valor)
  c[:"#{prefixo}_#{valor.to_s.downcase.gsub(/[^a-z0-9]+/, '_')[0, 40]}"] += 1 unless valor.to_s.empty?
end

def importar!
  conta = Account.find(CONTA_ID)
  raise ErroNosso, 'ARQUIVO=<jsonl do exportador> é obrigatório' if ARQUIVO.empty? || !File.file?(ARQUIVO)

  inbox = achar_caixa(conta)
  c = Hash.new(0)
  log "conta #{conta.id}, caixa #{inbox.id} (WhatsApp Cloud); #{GRAVAR ? 'GRAVANDO' : 'CONFERÊNCIA EM SECO'}"

  # ── lê e valida o arquivo ──
  cabecalho = nil
  linhas = []
  File.foreach(ARQUIVO) do |texto|
    j = JSON.parse(texto)
    if j['tipo'] == 'cabecalho'
      cabecalho = j
      next
    end
    c[:cartoes_no_arquivo] += 1
    linha, motivo = K.validar(j)
    if linha
      linhas << linha
    else
      c[:"linha_recusada_#{motivo}"] += 1
    end
  rescue JSON::ParserError
    c[:linha_recusada_json] += 1
  end
  raise ErroNosso, 'o arquivo não tem o cabeçalho do exportador (arquivo errado?)' unless cabecalho

  linhas = K.ordenar(linhas)
  linhas = linhas.first(LIMITE) if LIMITE.positive?
  log "arquivo da unidade #{cabecalho['unidade'].to_s[0, 60]}: #{c[:cartoes_no_arquivo]} cartões, #{linhas.size} válidos para importar"

  # ── o que já existe (idempotência: a chave é o id do cartão) ──
  ja = Conversation.where(account_id: conta.id).where('COALESCE(jsonb_exists(additional_attributes, ?), false)', K::MARCA_CONVERSA)
                   .pluck(Arel.sql("(additional_attributes ->> '#{K::MARCA_CONVERSA}')::bigint"), :id).to_h
  definicoes = conta.custom_attribute_definitions.where(attribute_model: 0).to_h { |d| [d.attribute_key, d] }
  etiquetas_da_conta = Label.where(account_id: conta.id).pluck(:title).to_set
  a_criar = K::ETIQUETAS_CRIADAS.reject { |e| etiquetas_da_conta.include?(e) }
  log "etiquetas que a conta ainda não tem e a importação cria: #{a_criar.join(', ')}" if a_criar.any?
  K::ETIQUETAS_CRIADAS.each { |e| garantir_etiqueta(conta, e) }
  etiquetas_da_conta.merge(K::ETIQUETAS_CRIADAS)
  tags = GRAVAR ? K::ETIQUETAS_CRIADAS.each_with_object({}) { |e, h| h[e] = tag_da(e) } : {}
  cache = {}
  begin
    linhas.each_with_index do |linha, i|
      log "#{i} cartões processados" if i.positive? && (i % 100).zero?
      begin
        achado = achar_contato(inbox, linha, cache)
        existente = ja[linha[:lead_id]]
        if existente
          c[:cartoes_ja_importados] += 1
        else
          c[:cartoes_novos] += 1
          if achado[:repetido]
            c[:cartoes_do_mesmo_telefone] += 1
          else
            case achado[:situacao]
            when :novo then c[:contatos_novos] += 1
            when :reaproveitado, :contato_sem_caixa then c[:contatos_reaproveitados] += 1
            when :com_conversa_viva then c[:contatos_com_conversa_viva_no_crm] += 1
            end
          end
        end
        contagem_por_valor(c, 'etapa', linha[:atributos]['etapa'])
        contagem_por_valor(c, 'etapa_tratamento', linha[:atributos]['etapa_tratamento'])
        c[:perdidos] += 1 if linha[:atributos]['etapa'] == 'Perdido'
        c[:mensagens_no_arquivo] += linha[:mensagens].size
        unless GRAVAR
          c[:erros_seguidos] = 0
          next
        end

        ids = { contatos: [], contact_inboxes: [], conversas: [], taggings: [], mensagens: [] }
        gravar_cartao!(conta, inbox, linha, achado, existente, definicoes, etiquetas_da_conta, tags, ids, c, cache)
        reg_ids(ids)
      rescue StandardError => e
        c[:erros] += 1
        log "erro em um cartão (#{erro_seguro(e)})"
        raise ErroNosso, '10 erros seguidos — paro' if (c[:erros_seguidos] += 1) >= 10
      else
        c[:erros_seguidos] = 0
      end
    end
  ensure
    c.delete(:erros_seguidos)
    log "RESUMO #{c.sort_by { |k, _| k.to_s }.map { |k, v| "#{k}=#{v}" }.join(' ')}"
    $ultimo_resumo = c
  end
end

def reg_ids(ids)
  ids.each { |tipo, lista| reg(tipo.to_s, lista.uniq) }
end

# Grava UM cartão numa transação; o registro (REG) só sai depois do commit.
def gravar_cartao!(conta, inbox, linha, achado, existente, definicoes, etiquetas_da_conta, tags, ids, c, cache)
  ultima = K.ultima_atividade(linha)
  criado = Time.at(linha[:criado_em]).utc
  d = Hash.new(0) # contagens do que SÓ vale depois do commit
  agora = Time.now.utc

  # atributos: só o que a conta DEFINE (e dentro da lista de opções), mais as chaves permitidas sem definição
  custom = {}
  linha[:atributos].each do |chave, valor|
    next if chave == K::MARCA_CONVERSA

    defn = definicoes[chave]
    if defn.nil?
      K::ATRIBUTOS_SEM_DEFINICAO.include?(chave) ? custom[chave] = valor : c[:atributos_sem_definicao] += 1
    elsif defn.attribute_values.present? && !defn.attribute_values.include?(valor)
      c[:atributos_fora_da_lista] += 1
    else
      custom[chave] = valor
    end
  end
  # etiquetas: só as que a conta tem (`historico` e `conferir-etapa` são criadas)
  nomes = []
  (linha[:etiquetas] | [K::ETIQUETA]).each do |e|
    if etiquetas_da_conta.include?(e)
      nomes << e
    else
      c[:etiquetas_inexistentes_na_conta] += 1
    end
  end
  canonico = K.variantes_do_fone(linha[:telefone]).first
  contato_id = achado[:contato_id]
  ci_id = achado[:ci_id]
  situacao = achado[:situacao]

  ActiveRecord::Base.transaction do
    # cartão JÁ importado: o contato e a conversa já existem (o paciente pode ter voltado a escrever e a conversa dele já ser «viva»); só se completa a conversa
    contato_id = Conversation.where(id: existente).pick(:contact_id) if existente
    unless contato_id
      contato_id = Contact.insert_all!([{ account_id: conta.id, name: linha[:nome], phone_number: "+#{canonico}",
                                          additional_attributes: { 'origem_historico' => 'kommo', 'kommo_contato_id' => linha[:contato_id] }.compact, custom_attributes: {},
                                          contact_type: 1, blocked: false, last_activity_at: ultima, created_at: criado, updated_at: ultima }],
                                       returning: %w[id]).rows.first.first
      ids[:contatos] << contato_id
    end
    if ci_id.nil? && !existente
      # contato novo, contato sem caixa, ou contato que já tem conversa viva (então o histórico fica no «HI.<número>», nunca no da conversa viva)
      fonte = situacao == :com_conversa_viva ? "HI.#{canonico}" : canonico
      ci_id = ContactInbox.where(inbox_id: inbox.id, source_id: fonte).pick(:id)
      unless ci_id
        ci_id = ContactInbox.insert_all!([{ inbox_id: inbox.id, contact_id: contato_id, source_id: fonte, hmac_verified: false, pubsub_token: SecureRandom.base58(24),
                                            created_at: criado, updated_at: ultima }], returning: %w[id]).rows.first.first
        ids[:contact_inboxes] << ci_id
      end
    end

    cid = existente
    novo = existente.nil?
    if novo
      cid = Conversation.insert_all!([{
        account_id: conta.id, inbox_id: inbox.id, contact_id: contato_id, contact_inbox_id: ci_id, status: 1, assignee_id: nil,
        additional_attributes: { K::MARCA_CONVERSA => linha[:lead_id], K::MARCA_ORIGEM => 'kommo' }, custom_attributes: custom,
        cached_label_list: nomes.join(', '), created_at: criado, updated_at: ultima, last_activity_at: ultima, status_changed_at: ultima,
        agent_last_seen_at: ultima, assignee_last_seen_at: ultima, waiting_since: nil
      }], returning: %w[id]).rows.first.first
      ids[:conversas] << cid
      tag_ids = nomes.map { |n| (tags[n] ||= tag_da(n)).id }
      ids[:taggings].concat(ActsAsTaggableOn::Tagging.insert_all!(tag_ids.map { |t| { tag_id: t, taggable_type: 'Conversation', taggable_id: cid, context: 'labels', created_at: agora } },
                                                                  returning: %w[id]).rows.flatten)
    else
      # re-rodada: NUNCA sobrescreve o que a equipe mexeu — só preenche atributo que ainda está VAZIO
      atual = Conversation.where(id: cid).pick(:custom_attributes) || {}
      faltam = custom.reject { |k, _| atual.key?(k) && atual[k].to_s != '' }
      Conversation.where(id: cid).update_all(['custom_attributes = COALESCE(custom_attributes, ?::jsonb) || ?::jsonb', '{}', faltam.to_json]) if faltam.any?
      d[:atributos_preenchidos_na_rerodada] += faltam.size
    end

    # mensagens: a NOTA-resumo (privada) e a conversa; pula o que já existe pelo source_id
    candidatas = [{ sid: K.source_id_da_nota(linha), em: K.hora_da_nota(linha) - 1, entrada: false, texto: linha[:nota], privada: true }] +
                 linha[:mensagens].map { |m| { sid: K.source_id_da_mensagem(linha, m), em: Time.at(m[:em]).utc, entrada: m[:entrada], texto: m[:texto], privada: false } }
    candidatas.reject! { |m| m[:texto].empty? }
    ja_tem = Message.where(inbox_id: inbox.id, source_id: candidatas.map { |m| m[:sid] }).pluck(:source_id).to_set
    novas = candidatas.reject { |m| ja_tem.include?(m[:sid]) }
    d[:mensagens_ja_existiam] += candidatas.size - novas.size
    novas.each_slice(500) do |fatia|
      rows = fatia.map do |m|
        base = { account_id: conta.id, inbox_id: inbox.id, conversation_id: cid, private: m[:privada], content_type: 0, content: m[:texto], processed_message_content: m[:texto],
                 source_id: m[:sid], created_at: m[:em], updated_at: m[:em] }
        if m[:privada]
          base.merge(message_type: 1, status: 0, sender_type: nil, sender_id: nil, content_attributes: {})
        elsif m[:entrada]
          base.merge(message_type: 0, status: 0, sender_type: 'Contact', sender_id: contato_id, content_attributes: {})
        else
          # igual ao «eco» que o Chatwoot grava quando a clínica responde por outro app: sem remetente, marcado como externo
          base.merge(message_type: 1, status: 1, sender_type: nil, sender_id: nil, content_attributes: { external_echo: true })
        end
      end
      ids[:mensagens].concat(Message.insert_all!(rows, returning: %w[id]).rows.flatten)
    end
    if !novo && novas.any?
      Conversation.where(id: cid, status: 1).update_all(['last_activity_at = GREATEST(last_activity_at, ?), updated_at = GREATEST(updated_at, ?)', ultima, ultima])
    end
    d[:mensagens_gravadas] += novas.count { |m| !m[:privada] }
    d[:notas_gravadas] += novas.count { |m| m[:privada] }
    d[:conversas_gravadas] += 1 if novo
  end
  d.each { |k, v| c[k] += v }
  # só DEPOIS do commit: os próximos cartões do MESMO telefone nesta rodada caem neste contato e neste contact_inbox
  cache[canonico] = { contato_id: contato_id, ci_id: ci_id, situacao: situacao == :com_conversa_viva ? :com_conversa_viva : :reaproveitado } unless existente
end

# ─── execução ───────────────────────────────────────────────────────────────────────────────────────────────────────
log "início — #{GRAVAR ? 'GRAVANDO' : 'CONFERÊNCIA EM SECO (nada é escrito)'}; conta #{CONTA_ID}#{LIMITE.positive? ? "; limite #{LIMITE} cartões" : ''}"
begin
  raise ErroNosso, ERROS_DE_PARAMETRO.join('; ') unless ERROS_DE_PARAMETRO.empty?

  if ENV['MODO'] == 'desfazer'
    desfazer!
  elsif ENV['MODO'] == 'checar'
    # só confere que a caixa do WhatsApp existe (o exportador lê a Kommo inteira: não vale começar sem ela)
    caixa = achar_caixa(Account.find(CONTA_ID))
    log "caixa #{caixa.id} (WhatsApp Cloud) encontrada na conta #{CONTA_ID}"
  else
    importar!
  end
  log 'FIM'
rescue StandardError => e
  log "ERRO FATAL (#{erro_seguro(e)})"
  log 'FIM'
  exit 1
end
