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
# da Kommo. A conversa leva `kommo_importado_em`: o backend a trata como ARQUIVO só enquanto ninguém mexeu depois da importação (o paciente que escreve
# cai nela, pela trava de conversa única, e ela passa a valer como qualquer conversa: régua, agenda, aviso de demora). Cartão com consulta de pé
# (AGENDADO etc.) já nasce VIVO: o paciente recebe os lembretes do CRM.
#
# O DESTINO É ESTÁVEL ENTRE RODADAS: a conversa que recebe a próxima mensagem do paciente é a de MAIOR id do contact_inbox. Um cartão só cria conversa nova
# se ele vale mais (aberto > fechado, depois o mais recentemente atualizado) do que o cartão da conversa de destino E essa conversa ainda é nossa e ninguém
# mexeu nela; em qualquer outro caso (a conversa que o paciente já tinha, a que a equipe já usou, um cartão mais velho) o cartão ENTRA nela SÓ com a nota-resumo
# e as mensagens — nunca atributo, nunca etiqueta (preencher campo numa conversa que a régua já conhece dispara mensagem). Piloto (LIMITE_CARTOES) e lote dão o mesmo destino.
#
# Variáveis:
#   GRAVAR=1             sem isto é CONFERÊNCIA EM SECO: só lê o arquivo e o banco e conta. NADA é escrito.
#   ARQUIVO=/tmp/...     o JSONL do exportador (obrigatório)
#   CONTA=3              id da conta do Chatwoot (padrão 3 = Doutor Hérnia Timbó)
#   CAIXA=n              id da caixa do WhatsApp (padrão: a ÚNICA caixa Channel::Whatsapp da conta; sem ela a rodada é RECUSADA)
#   LIMITE_CARTOES=n     só os n primeiros cartões do arquivo, na ordem de gravação (n > 0; 0 é recusado)
#   MODO=desfazer        com REGISTRO=arquivo (linhas REG de uma rodada que gravou): desfaz o que ela criou (seco sem GRAVAR=1)
require 'json'
require 'digest'
require 'securerandom'
require 'set'
require File.join(ENV['HS_DIR'] || File.dirname(File.expand_path(__FILE__)), 'kommo_historico')

K = KommoHistorico unless defined?(K)
# STDOUT (e não $stdout): sob `rails runner` o $stdout é bufferizado e o acompanhamento só veria o log no fim da rodada
STDOUT.sync = true

GRAVAR = ENV['GRAVAR'] == '1'
ERROS_DE_PARAMETRO = []
CONTA_ID = (ENV['CONTA'] || '3').to_i
# a conta 1 é a de Parauapebas (a clínica no ar): este importador é só das contas de unidades novas — recusa SEMPRE, em qualquer modo
ERROS_DE_PARAMETRO << 'a conta 1 (Parauapebas) é recusada: este importador nunca grava nela' if CONTA_ID <= 1
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

  # tudo é restrito à CONTA pedida: um registro de outra conta (ou ids reaproveitados) não apaga nada daqui
  conta_msgs = Message.where(account_id: CONTA_ID)
  convs = Conversation.where(account_id: CONTA_ID, id: tudo['conversas'].uniq).pluck(:id)
  mensagens_registro = conta_msgs.where(id: tudo['mensagens'].uniq).pluck(:id)
  ignoradas = tudo['mensagens'].uniq.size - mensagens_registro.size
  log "desfazer: #{ignoradas} mensagem(ns) do registro NÃO são desta conta ou já não existem: ignoradas" if ignoradas.positive?
  # a conversa CRIADA pela rodada só sai se NINGUÉM a usou depois (resolvida, sem responsável, nenhuma mensagem fora do registro). UMA consulta para todas.
  com_mensagem_de_fora = Message.where(conversation_id: convs).where.not(id: mensagens_registro).reorder(nil).distinct.pluck(:conversation_id).to_set
  intocadas = Conversation.where(id: convs).select { |cv| cv.status == 'resolved' && cv.assignee_id.nil? && !com_mensagem_de_fora.include?(cv.id) }.map(&:id)
  mexidas = convs - intocadas
  # TODAS as mensagens do registro são nossas e saem — também as que uma 2ª rodada acrescentou em conversa que já existia (ou na conversa viva do paciente)
  fora_das_apagadas = Message.where(id: mensagens_registro).where.not(conversation_id: intocadas).count
  log "desfazer: conversas criadas=#{convs.size} (intocadas=#{intocadas.size}; as #{mexidas.size} que a equipe já usou — mensagem, reabertura ou responsável — ficam) " \
      "mensagens do registro=#{mensagens_registro.size} (#{fora_das_apagadas} em conversa que fica) contatos=#{tudo['contatos'].uniq.size} contact_inboxes=#{tudo['contact_inboxes'].uniq.size}"
  unless GRAVAR
    log 'SECO: nada foi apagado. Rode com GRAVAR=1 (e --confirmo-apagar) para desfazer.'
    return
  end
  ActiveRecord::Base.transaction do
    msgs = Message.where(account_id: CONTA_ID, id: mensagens_registro).delete_all
    # etiquetas das conversas que a importação CRIOU e que ficam (a equipe já as usou): saem pelo id do registro, e o cache de etiquetas da conversa é refeito
    tagging_ids = tudo['taggings'].uniq
    tagging_ids = ActsAsTaggableOn::Tagging.where(id: tagging_ids, taggable_type: 'Conversation', taggable_id: Conversation.where(account_id: CONTA_ID).select(:id)).pluck(:id)
    afetadas = ActsAsTaggableOn::Tagging.where(id: tagging_ids).pluck(:taggable_id).uniq - intocadas
    tags = ActsAsTaggableOn::Tagging.where(id: tagging_ids).delete_all
    afetadas.each do |cid|
      nomes = ActsAsTaggableOn::Tagging.joins(:tag).where(taggable_type: 'Conversation', taggable_id: cid, context: 'labels').pluck('tags.name')
      Conversation.where(id: cid).update_all(cached_label_list: nomes.join(', '))
    end
    cs = Conversation.where(account_id: CONTA_ID, id: intocadas).delete_all
    cis = ContactInbox.where(id: tudo['contact_inboxes'].uniq, inbox_id: Inbox.where(account_id: CONTA_ID).select(:id)).pluck(:id).select { |ci| !Conversation.where(contact_inbox_id: ci).exists? }
    ContactInbox.where(id: cis).delete_all
    # contato que a EQUIPE mexeu (nota, etiqueta, campo, e-mail/identificador) NÃO é apagado: delete_all deixaria as notas órfãs
    cts = []
    editados = 0
    Contact.where(account_id: CONTA_ID, id: tudo['contatos'].uniq).find_each do |ct|
      mexido = Note.where(contact_id: ct.id).exists? || ActsAsTaggableOn::Tagging.where(taggable_type: 'Contact', taggable_id: ct.id).exists? ||
               ct.custom_attributes.present? || ct.email.present? || ct.identifier.present?
      if mexido
        editados += 1
      elsif !ContactInbox.where(contact_id: ct.id).exists? && !Conversation.where(contact_id: ct.id).exists?
        cts << ct.id
      end
    end
    Contact.where(account_id: CONTA_ID, id: cts).delete_all
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
  # SEM a trava de conversa única (a de Parauapebas tem), a próxima mensagem do paciente abre uma conversa NOVA e o histórico importado fica parado
  # ao lado, sem etapa nem atributos na conversa que a equipe vai usar. Ligue `lock_to_single_conversation` na caixa antes.
  raise ErroNosso, "a caixa #{caixa.id} está com a trava de conversa única DESLIGADA (lock_to_single_conversation): a mensagem do paciente não cairia na conversa importada. Ligue a trava na caixa (como a de Parauapebas) e rode de novo" unless caixa.lock_to_single_conversation

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

def conversa_nossa?(cv)
  cv.additional_attributes.is_a?(Hash) && cv.additional_attributes.key?(K::MARCA_CONVERSA)
end

# O contato desta pessoa na caixa → { contato_id:, ci_id:, situacao: }
#  - já há contact_inbox com o telefone (qualquer formato do Brasil: com e sem o 9) → o reaproveita (NUNCA se cria outro contact_inbox: resposta por um
#    «HI.<número>» iria para um destino que a Meta recusa);
#  - senão o contato pode existir sem caixa (mesmo telefone) → reaproveita o contato e cria o contact_inbox;
#  - senão nasce contato + contact_inbox, com o source_id no formato do WhatsApp Cloud (só dígitos, com DDI).
# `situacao` :com_conversa_no_crm = o paciente JÁ escreveu pelo WhatsApp (há conversa que não é nossa). O DESTINO do cartão sai de `decidir_destino`.
# `cache` (por telefone) faz os cartões do MESMO telefone na rodada caírem no mesmo contato.
def achar_contato(inbox, linha, cache)
  variantes = K.variantes_do_fone(linha[:telefone])
  canonico = variantes.first
  return cache[canonico].merge(repetido: true) if cache.key?(canonico)

  ci = ContactInbox.where(inbox_id: inbox.id, source_id: variantes).order(:id).first
  if ci
    do_paciente = Conversation.where(contact_inbox_id: ci.id).to_a.any? { |cv| !conversa_nossa?(cv) }
    return cache[canonico] = { contato_id: ci.contact_id, ci_id: ci.id, situacao: do_paciente ? :com_conversa_no_crm : :reaproveitado }
  end
  ct = Contact.where(account_id: inbox.account_id, phone_number: variantes.map { |v| "+#{v}" }).order(:id).first
  return cache[canonico] = { contato_id: ct.id, ci_id: nil, situacao: :contato_sem_caixa } if ct

  cache[canonico] = { contato_id: nil, ci_id: nil, situacao: :novo }
end

# Ninguém mexeu na conversa NOSSA desde a gravação: resolvida e a última atividade não passou do instante da importação (a mesma regra do backend, `ehArquivo`).
def intacta?(cv)
  ad = cv.additional_attributes.is_a?(Hash) ? cv.additional_attributes : {}
  em = ad[K::MARCA_IMPORTADO_EM]
  em.is_a?(Integer) && cv.resolved? && cv.last_activity_at.to_i <= em
end

# Onde o cartão entra → nil = CRIAR a conversa do cartão; id = ENTRAR nessa conversa (só nota-resumo e mensagens, nunca atributo nem etiqueta).
# A conversa de DESTINO é a de maior id do contact_inbox (a trava de conversa única manda a próxima mensagem do paciente para ela).
#  - não há conversa → cria;
#  - a conversa é do paciente (não é nossa) ou a equipe/o paciente já mexeu nela → entra;
#  - a conversa é nossa e intacta: o cartão que vale MAIS (`K.ordem_do_cartao`) cria a conversa nova (que passa a ser o destino); o que vale menos entra nela.
# O resultado só depende dos cartões e da posição deles, não da rodada em que cada um chega (piloto + lote = mesmo destino).
def decidir_destino(linha, ci_id)
  return nil unless ci_id

  destino = Conversation.where(contact_inbox_id: ci_id).order(id: :desc).first
  return nil unless destino
  return destino.id unless conversa_nossa?(destino)
  return destino.id unless intacta?(destino)

  ordem_do_destino = destino.additional_attributes[K::MARCA_ORDEM]
  return destino.id unless ordem_do_destino.is_a?(Array)

  (K.ordem_do_cartao(linha) <=> ordem_do_destino.map(&:to_i)) == 1 ? nil : destino.id
end

def contagem_por_valor(c, prefixo, valor)
  c[:"#{prefixo}_#{valor.to_s.downcase.gsub(/[^a-z0-9]+/, '_')[0, 40]}"] += 1 unless valor.to_s.empty?
end

def importar!
  conta = Account.find(CONTA_ID)
  raise ErroNosso, 'ARQUIVO=<jsonl do exportador> é obrigatório' if ARQUIVO.empty? || !File.file?(ARQUIVO)

  inbox = achar_caixa(conta)
  c = Hash.new(0)
  log "conta #{conta.id}, caixa #{inbox.id} (WhatsApp Cloud, trava de conversa única ligada); #{GRAVAR ? 'GRAVANDO' : 'CONFERÊNCIA EM SECO'}"

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
  # o exportador grava a conta do Chatwoot DA UNIDADE (unit_chatwoot.conta_id): arquivo de uma clínica nunca entra na conta de outra
  raise ErroNosso, "o arquivo é da conta #{cabecalho['conta_id'].inspect} do Chatwoot e a rodada pediu a conta #{conta.id}: recusado (arquivo sem conta_id também é recusado)" unless cabecalho['conta_id'].is_a?(Integer) && cabecalho['conta_id'] == conta.id

  linhas = K.ordenar(linhas)
  linhas = linhas.first(LIMITE) if LIMITE.positive?
  log "arquivo da unidade #{cabecalho['unidade'].to_s[0, 60]}: #{c[:cartoes_no_arquivo]} cartões, #{linhas.size} válidos para importar"

  # ── o que já existe (idempotência: a chave é o id do cartão) ──
  # cartão importado = conversa NOSSA com a marca, OU a nota-resumo (`kommo-nota:<cartão>`) em qualquer conversa da caixa (as que entraram na conversa viva do paciente)
  ja = Conversation.where(account_id: conta.id).where('COALESCE(jsonb_exists(additional_attributes, ?), false)', K::MARCA_CONVERSA)
                   .pluck(Arel.sql("(additional_attributes ->> '#{K::MARCA_CONVERSA}')::bigint"), :id).to_h
  Message.where(inbox_id: inbox.id).where('source_id LIKE ?', 'kommo-nota:%').pluck(:source_id, :conversation_id).each { |sid, cid| ja[sid.split(':').last.to_i] ||= cid }
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
        destino = existente ? nil : decidir_destino(linha, achado[:ci_id])
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
            when :com_conversa_no_crm then c[:contatos_com_conversa_no_crm] += 1
            end
          end
          c[destino ? :cartoes_que_entram_em_conversa_existente : :cartoes_que_criam_conversa] += 1
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
        gravar_cartao!(conta, inbox, linha, achado, existente || destino, definicoes, etiquetas_da_conta, tags, ids, c, cache)
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
    # as conversas VIVAS (não arquivo) que o histórico deixa: as nossas nascem resolvidas+historico+marca (0 por construção); contam as que a equipe reabriu
    c[:conversas_importadas_reabertas_pela_equipe] = Conversation.where(id: ja.values.uniq, status: [0, 2, 3]).where('COALESCE(jsonb_exists(additional_attributes, ?), false)', K::MARCA_CONVERSA).count
    log "RESUMO #{c.sort_by { |k, _| k.to_s }.map { |k, v| "#{k}=#{v}" }.join(' ')}"
    $ultimo_resumo = c
  end
end

def reg_ids(ids)
  ids.each { |tipo, lista| reg(tipo.to_s, lista.uniq) }
end

# Grava UM cartão numa transação; o registro (REG) só sai depois do commit.
# `alvo` = a conversa em que o cartão ENTRA (a do próprio cartão, se já foi importado; ou o destino decidido por `decidir_destino`); nil = criar a conversa do cartão.
def gravar_cartao!(conta, inbox, linha, achado, alvo, definicoes, etiquetas_da_conta, tags, ids, c, cache)
  ultima = K.ultima_atividade(linha)
  criado = Time.at(linha[:criado_em]).utc
  agora = Time.now.utc
  d = Hash.new(0) # contagens do que SÓ vale depois do commit

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
  # as Tags (tabela global do acts_as_taggable) saem ANTES da transação: criada dentro e desfeita por um erro, a Tag sumiria e o cache `tags` apontaria para um id que não existe
  (nomes | [K::ETIQUETA]).each { |n| tags[n] ||= tag_da(n) }
  canonico = K.variantes_do_fone(linha[:telefone]).first
  contato_id = achado[:contato_id]
  ci_id = achado[:ci_id]

  ActiveRecord::Base.transaction do
    # a conversa já existe (cartão já importado, ou a conversa de destino do paciente): o contato e o contact_inbox dela são os dela
    contato_id, ci_id = Conversation.where(id: alvo).pick(:contact_id, :contact_inbox_id) if alvo
    unless contato_id
      contato_id = Contact.insert_all!([{ account_id: conta.id, name: linha[:nome], phone_number: "+#{canonico}",
                                          additional_attributes: { 'origem_historico' => 'kommo', 'kommo_contato_id' => linha[:contato_id] }.compact, custom_attributes: {},
                                          contact_type: 1, blocked: false, last_activity_at: ultima, created_at: criado, updated_at: ultima }],
                                       returning: %w[id]).rows.first.first
      ids[:contatos] << contato_id
    end
    if ci_id.nil? && !alvo
      # contato novo, ou contato que existia sem caixa: o contact_inbox nasce com o source_id do WhatsApp Cloud (só dígitos, com DDI)
      ci_id = ContactInbox.where(inbox_id: inbox.id, source_id: canonico).pick(:id)
      unless ci_id
        ci_id = ContactInbox.insert_all!([{ inbox_id: inbox.id, contact_id: contato_id, source_id: canonico, hmac_verified: false, pubsub_token: SecureRandom.base58(24),
                                            created_at: criado, updated_at: ultima }], returning: %w[id]).rows.first.first
        ids[:contact_inboxes] << ci_id
      end
    end

    cid = alvo
    novo = alvo.nil?
    if novo
      # `kommo_importado_em`: o backend só trata a conversa como arquivo enquanto a última atividade não passa dele; nunca antes da última atividade gravada
      importado_em = [agora.to_i, ultima.to_i].max
      cid = Conversation.insert_all!([{
        account_id: conta.id, inbox_id: inbox.id, contact_id: contato_id, contact_inbox_id: ci_id, status: 1, assignee_id: nil,
        additional_attributes: { K::MARCA_CONVERSA => linha[:lead_id], K::MARCA_ORIGEM => 'kommo', K::MARCA_IMPORTADO_EM => importado_em, K::MARCA_ORDEM => K.ordem_do_cartao(linha) },
        custom_attributes: custom,
        cached_label_list: nomes.join(', '), created_at: criado, updated_at: ultima, last_activity_at: ultima, status_changed_at: ultima,
        agent_last_seen_at: ultima, assignee_last_seen_at: ultima, waiting_since: nil
      }], returning: %w[id]).rows.first.first
      ids[:conversas] << cid
      tag_ids = nomes.map { |n| (tags[n] ||= tag_da(n)).id }
      ids[:taggings].concat(ActsAsTaggableOn::Tagging.insert_all!(tag_ids.map { |t| { tag_id: t, taggable_type: 'Conversation', taggable_id: cid, context: 'labels', created_at: agora } },
                                                                  returning: %w[id]).rows.flatten)
    end
    # conversa que JÁ existe (a que o paciente tinha, a que a equipe já usou, uma nossa mais nova): o cartão entra só com a nota-resumo e as mensagens. NENHUM atributo,
    # NENHUMA etiqueta: valor novo numa conversa que a régua já conhece (ver `atualizarVistos`) é «entrou agora» e dispara mensagem; etiqueta `historico` numa conversa
    # viva a silenciaria (aviso de demora, campos obrigatórios) — por isso nada disso é posto fora da conversa que a importação CRIA.

    # mensagens: a NOTA-resumo (privada) e a conversa; pula o que já existe pelo source_id
    candidatas = [{ sid: K.source_id_da_nota(linha), em: K.hora_da_nota(linha) - 1, entrada: false, texto: linha[:nota], privada: true }] +
                 linha[:mensagens].map { |m| { sid: K.source_id_da_mensagem(linha, m), em: Time.at(m[:em]).utc, entrada: m[:entrada], texto: m[:texto], privada: false } }
    candidatas.reject! { |m| m[:texto].empty? }
    ja_tem = Message.where(inbox_id: inbox.id, source_id: candidatas.map { |m| m[:sid] }).pluck(:source_id).to_set
    novas = candidatas.reject { |m| ja_tem.include?(m[:sid]) }
    d[:mensagens_ja_existiam] += candidatas.size - novas.size
    # a nota de uma rodada em que a Kommo não entregou a conversa diz isso; se agora entregou, a nota é reescrita (conteúdo só — sem callback, em silêncio)
    nota_sid = K.source_id_da_nota(linha)
    if ja_tem.include?(nota_sid) && !linha[:nota].to_s.include?(K::NOTA_SEM_CONVERSA)
      velha = Message.where(inbox_id: inbox.id, source_id: nota_sid, private: true).select(:id, :content).first
      if velha && velha.content.to_s.include?(K::NOTA_SEM_CONVERSA)
        Message.where(id: velha.id).update_all(content: linha[:nota], processed_message_content: linha[:nota])
        d[:notas_reescritas] += 1
      end
    end
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
    # a última atividade de conversa NOSSA e ainda resolvida só AVANÇA, e nunca além do instante da importação (passar dele a tornaria «mexida»: viva); a conversa
    # do paciente nunca é mexida (mensagem antiga não a «rejuvenesce»)
    if !novo && novas.any?
      Conversation.where(id: cid, status: 1).where('COALESCE(jsonb_exists(additional_attributes, ?), false) AND COALESCE(jsonb_exists(additional_attributes, ?), false)', K::MARCA_CONVERSA, K::MARCA_IMPORTADO_EM)
                  .update_all(['last_activity_at = GREATEST(last_activity_at, LEAST(?::timestamp, (to_timestamp((additional_attributes ->> ?)::bigint) AT TIME ZONE \'UTC\'))), ' \
                               'updated_at = GREATEST(updated_at, LEAST(?::timestamp, (to_timestamp((additional_attributes ->> ?)::bigint) AT TIME ZONE \'UTC\')))', ultima, K::MARCA_IMPORTADO_EM, ultima, K::MARCA_IMPORTADO_EM])
    end
    d[:mensagens_gravadas] += novas.count { |m| !m[:privada] }
    d[:notas_gravadas] += novas.count { |m| m[:privada] }
    d[:conversas_gravadas] += 1 if novo
  end
  d.each { |k, v| c[k] += v }
  # só DEPOIS do commit: os próximos cartões do MESMO telefone nesta rodada caem neste contato e neste contact_inbox
  cache[canonico] = { contato_id: contato_id, ci_id: ci_id || achado[:ci_id], situacao: achado[:situacao] }
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
