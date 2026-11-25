# frozen_string_literal: true

# Biblioteca PURA (sem Rails, sem banco) do importador do histórico da Kommo para o CRM: o contrato da linha, as variantes do telefone
# do WhatsApp e os limites. Testada com `ruby` puro (kommo_historico_test.rb). Nada aqui imprime nome, telefone, texto ou token.
require 'json'
require 'time'

module KommoHistorico
  ETIQUETA = 'historico'
  ETIQUETA_CONFERIR = 'conferir-etapa'
  # etiquetas que o importador CRIA na conta se faltarem (as outras só valem se a conta já as tiver)
  ETIQUETAS_CRIADAS = [ETIQUETA, ETIQUETA_CONFERIR].freeze
  MARCA_CONVERSA = 'kommo_lead_id' # additional_attributes da conversa: o id do cartão na Kommo (a chave de idempotência)
  MARCA_ORIGEM = 'origem_historico'
  # instante (epoch, segundos) em que a conversa foi gravada: o backend (`ehArquivo`) só trata a conversa como arquivo ENQUANTO ninguém mexeu depois dele
  MARCA_IMPORTADO_EM = 'kommo_importado_em'
  # a posição do cartão na conversa [aberto?1:0, atualizado_em, lead_id]: decide, em qualquer rodada, se um cartão novo vira a conversa de destino ou entra na que já existe
  MARCA_ORDEM = 'kommo_ordem'
  # o trecho que a nota-resumo traz quando a Kommo não entregou a conversa (a mesma frase do backend, kommo-historico-crm.ts): se a rodada seguinte consegue ler, a nota é reescrita
  NOTA_SEM_CONVERSA = 'a Kommo não entregou a conversa deste cartão'
  # chaves que a conversa recebe mesmo sem atributo definido na conta (o código do CRM já as lê; a tela só mostra quando o kit as criar)
  ATRIBUTOS_SEM_DEFINICAO = %w[origem valor_fechado].freeze
  LIMITE_TEXTO = 20_000
  LIMITE_NOTA = 4_000
  TETO_MENSAGENS = 50

  module_function

  # Os formatos do mesmo número brasileiro (com e sem o 9 depois do DDD), como o Chatwoot os casa (BrazilPhoneNormalizer): só celular (o número
  # local começa em 6–9) tem as duas formas; fixo e outro país têm uma só. O PRIMEIRO da lista é o canônico (o que vira source_id).
  def variantes_do_fone(digitos)
    d = digitos.to_s.gsub(/\D/, '')
    if (m = /\A55(\d{2})9(\d{8})\z/.match(d))
      return [d, "55#{m[1]}#{m[2]}"]
    end
    if (m = /\A55(\d{2})([6-9]\d{7})\z/.match(d))
      return ["55#{m[1]}9#{m[2]}", d]
    end
    [d]
  end

  def limpar(texto, limite = LIMITE_TEXTO)
    texto.to_s.delete("\u0000").strip[0, limite]
  end

  # Valida UMA linha do arquivo e a devolve normalizada. [linha, nil] ou [nil, :motivo].
  def validar(h)
    return [nil, :nao_e_objeto] unless h.is_a?(Hash)
    return [nil, :tipo] unless h['tipo'] == 'cartao' && h['v'] == 1
    return [nil, :sem_id] unless h['lead_id'].is_a?(Integer) && h['lead_id'].positive?

    fone = h['telefone'].to_s
    return [nil, :sem_telefone] unless fone.match?(/\A\d{11,15}\z/)
    return [nil, :datas] unless [h['criado_em'], h['atualizado_em']].all? { |x| x.is_a?(Integer) && x.positive? }

    atributos = h['atributos'].is_a?(Hash) ? h['atributos'].select { |k, v| k.to_s.match?(/\A[a-z_]{1,60}\z/) && [String, Integer, Float, TrueClass, FalseClass].any? { |c| v.is_a?(c) } } : {}
    etiquetas = Array(h['etiquetas']).select { |e| e.is_a?(String) && e.match?(/\A[a-z0-9-]{1,60}\z/) }.uniq
    mensagens = Array(h['mensagens']).filter_map do |m|
      next unless m.is_a?(Hash) && m['id'].to_s != '' && m['em'].is_a?(Integer) && m['em'].positive?

      texto = limpar(m['texto'])
      next if texto.empty?

      { id: m['id'].to_s[0, 120], em: m['em'], entrada: m['entrada'] == true, texto: texto }
    end.last(TETO_MENSAGENS)
    linha = {
      lead_id: h['lead_id'], contato_id: h['contato_id'].is_a?(Integer) ? h['contato_id'] : nil,
      nome: limpar(h['nome'], 255).then { |n| n.empty? ? "Cartão #{h['lead_id']}" : n }, telefone: fone,
      funil_kommo: limpar(h['funil_kommo'], 80), etapa_kommo: limpar(h['etapa_kommo'], 80), aberto: h['aberto'] == true,
      criado_em: h['criado_em'], atualizado_em: h['atualizado_em'], fechado_em: h['fechado_em'].is_a?(Integer) ? h['fechado_em'] : nil,
      atributos: atributos, etiquetas: etiquetas, nota: limpar(h['nota'], LIMITE_NOTA), mensagens: mensagens
    }
    [linha, nil]
  end

  # Hora que a conversa mostra como a última atividade: a da última mensagem, senão a da última mudança do cartão.
  def ultima_atividade(linha)
    ultima = linha[:mensagens].map { |m| m[:em] }.max
    Time.at([ultima, linha[:atualizado_em]].compact.max).utc
  end

  # Hora da NOTA-resumo: logo antes da 1ª mensagem (ou na criação do cartão), para ela abrir a conversa.
  def hora_da_nota(linha)
    primeira = linha[:mensagens].map { |m| m[:em] }.min
    Time.at([linha[:criado_em], primeira].compact.min).utc
  end

  def source_id_da_mensagem(linha, msg)
    "kommo:#{linha[:lead_id]}:#{msg[:id]}"[0, 250]
  end

  def source_id_da_nota(linha)
    "kommo-nota:#{linha[:lead_id]}"
  end

  # A posição do cartão: aberto vale mais que fechado; dentro do grupo, o atualizado mais recentemente; empate, o id da Kommo.
  def ordem_do_cartao(linha)
    [linha[:aberto] ? 1 : 0, linha[:atualizado_em].to_i, linha[:lead_id].to_i]
  end

  # Ordem de gravação: da menor posição para a maior (fechados primeiro, depois abertos; do mais velho para o mais novo) — o cartão mais vivo recebe o
  # id MAIOR, e é nele que a próxima mensagem do paciente cai (a caixa trava em conversa única: o Chatwoot usa a conversa de maior id do contato).
  def ordenar(linhas)
    linhas.sort_by { |l| ordem_do_cartao(l) }
  end
end
