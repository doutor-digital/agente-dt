# frozen_string_literal: true

# Testes da parte PURA do importador da Kommo (sem Rails, sem banco):  ruby ops/crm-historico-kommo/kommo_historico_test.rb
require 'minitest/autorun'
require_relative 'kommo_historico'

class KommoHistoricoTest < Minitest::Test
  K = KommoHistorico

  def linha(extra = {})
    { 'tipo' => 'cartao', 'v' => 1, 'lead_id' => 777, 'contato_id' => 55, 'nome' => 'Maria', 'telefone' => '5547991234567', 'funil_kommo' => 'COMERCIAL', 'etapa_kommo' => 'AGENDADO',
      'aberto' => true, 'criado_em' => 1_790_000_000, 'atualizado_em' => 1_790_100_000, 'fechado_em' => nil, 'atributos' => { 'etapa' => 'Agendado', 'kommo_lead_id' => 777 },
      'etiquetas' => ['historico'], 'nota' => 'nota', 'mensagens' => [{ 'id' => 'a', 'em' => 1_790_000_100, 'entrada' => true, 'texto' => 'oi' }] }.merge(extra)
  end

  def test_variantes_do_celular_brasileiro_com_e_sem_o_9
    assert_equal %w[5547991234567 554791234567], K.variantes_do_fone('5547991234567')
    assert_equal %w[5547991234567 554791234567], K.variantes_do_fone('554791234567'), 'o canônico é o com 9, mesmo que o número tenha vindo sem'
    assert_equal ['554733334444'], K.variantes_do_fone('554733334444'), 'fixo (começa em 3) não ganha 9'
    assert_equal ['351912345678'], K.variantes_do_fone('351912345678')
    assert_equal %w[5547991234567 554791234567], K.variantes_do_fone('+55 (47) 99123-4567')
  end

  def test_linha_valida_normaliza
    l, motivo = K.validar(linha)
    assert_nil motivo
    assert_equal 777, l[:lead_id]
    assert_equal '5547991234567', l[:telefone]
    assert_equal 1, l[:mensagens].size
    assert l[:mensagens][0][:entrada]
  end

  def test_recusas_com_motivo
    assert_equal [nil, :nao_e_objeto], K.validar('x')
    assert_equal :tipo, K.validar(linha('tipo' => 'outra'))[1]
    assert_equal :tipo, K.validar(linha('v' => 2))[1]
    assert_equal :sem_id, K.validar(linha('lead_id' => 'abc'))[1]
    assert_equal :sem_id, K.validar(linha('lead_id' => 0))[1]
    assert_equal :sem_telefone, K.validar(linha('telefone' => nil))[1]
    assert_equal :sem_telefone, K.validar(linha('telefone' => '123'))[1]
    assert_equal :sem_telefone, K.validar(linha('telefone' => '+5547991234567'))[1], 'só dígitos'
    assert_equal :datas, K.validar(linha('criado_em' => nil))[1]
  end

  def test_atributos_so_com_chave_e_valor_validos
    l, = K.validar(linha('atributos' => { 'etapa' => 'Agendado', 'Chave Ruim' => 'x', 'objeto' => { 'a' => 1 }, 'lista' => [1], 'ok_bool' => true, 'valor_fechado' => 4500 }))
    assert_equal %w[etapa ok_bool valor_fechado], l[:atributos].keys
  end

  def test_etiquetas_so_formato_de_etiqueta
    l, = K.validar(linha('etiquetas' => ['historico', 'Perdido X', 'perdido-sem-interesse', 3, 'historico']))
    assert_equal %w[historico perdido-sem-interesse], l[:etiquetas]
  end

  def test_mensagens_limpam_nul_descartam_vazias_e_ficam_com_as_ultimas
    msgs = (1..70).map { |i| { 'id' => "m#{i}", 'em' => 1_790_000_000 + i, 'entrada' => i.odd?, 'texto' => "t#{i}" } }
    msgs << { 'id' => 'vazia', 'em' => 1_790_000_999, 'texto' => '  ' } << { 'id' => 'nul', 'em' => 1_790_001_000, 'texto' => "a\u0000b" } << { 'id' => '', 'em' => 5, 'texto' => 'sem id' }
    l, = K.validar(linha('mensagens' => msgs))
    assert_equal K::TETO_MENSAGENS, l[:mensagens].size
    assert_equal 'ab', l[:mensagens].last[:texto]
    refute l[:mensagens].any? { |m| m[:id] == 'vazia' || m[:id].empty? }
  end

  def test_texto_enorme_e_cortado
    l, = K.validar(linha('nota' => 'n' * 9000, 'mensagens' => [{ 'id' => 'a', 'em' => 1_790_000_100, 'texto' => 'x' * 50_000 }]))
    assert_equal K::LIMITE_NOTA, l[:nota].size
    assert_equal K::LIMITE_TEXTO, l[:mensagens][0][:texto].size
  end

  def test_ultima_atividade_e_hora_da_nota
    l, = K.validar(linha)
    assert_equal Time.at(1_790_100_000).utc, K.ultima_atividade(l), 'a mudança do cartão é mais nova que a última mensagem'
    l2, = K.validar(linha('atualizado_em' => 1_790_000_050))
    assert_equal Time.at(1_790_000_100).utc, K.ultima_atividade(l2), 'a última mensagem é mais nova'
    assert_equal Time.at(1_790_000_000).utc, K.hora_da_nota(l), 'a nota abre a conversa'
  end

  def test_ordem_de_gravacao_fechados_primeiro_abertos_por_ultimo_e_o_mais_vivo_com_o_maior_id
    a, = K.validar(linha('lead_id' => 1, 'aberto' => true, 'atualizado_em' => 300))
    b, = K.validar(linha('lead_id' => 2, 'aberto' => false, 'atualizado_em' => 900))
    c, = K.validar(linha('lead_id' => 3, 'aberto' => true, 'atualizado_em' => 100))
    assert_equal [2, 3, 1], K.ordenar([a, b, c]).map { |x| x[:lead_id] }
  end

  def test_ordem_do_cartao_aberto_vale_mais_que_fechado_e_depois_o_mais_recente
    aberto_velho, = K.validar(linha('lead_id' => 1, 'aberto' => true, 'atualizado_em' => 100))
    fechado_novo, = K.validar(linha('lead_id' => 2, 'aberto' => false, 'atualizado_em' => 900))
    aberto_novo, = K.validar(linha('lead_id' => 3, 'aberto' => true, 'atualizado_em' => 500))
    assert_equal [1, 100, 1], K.ordem_do_cartao(aberto_velho)
    assert_equal 1, (K.ordem_do_cartao(aberto_velho) <=> K.ordem_do_cartao(fechado_novo)), 'aberto vale mais que fechado, mesmo mais velho'
    assert_equal 1, (K.ordem_do_cartao(aberto_novo) <=> K.ordem_do_cartao(aberto_velho))
    assert_equal(-1, (K.ordem_do_cartao(fechado_novo) <=> [1, 0, 0]))
    # a ordem de gravação e a de destino são a MESMA: o último gravado é o que vale mais
    assert_equal K.ordenar([aberto_novo, fechado_novo, aberto_velho]).last[:lead_id], [aberto_velho, fechado_novo, aberto_novo].max_by { |l| K.ordem_do_cartao(l) }[:lead_id]
  end

  def test_nota_sem_conversa_e_a_mesma_frase_do_backend
    assert_includes 'Conversa: a Kommo não entregou a conversa deste cartão (sem permissão de chats ou sem conversa).', K::NOTA_SEM_CONVERSA
  end

  def test_source_ids_distintos_por_cartao_e_por_mensagem
    l, = K.validar(linha)
    assert_equal 'kommo:777:a', K.source_id_da_mensagem(l, l[:mensagens][0])
    assert_equal 'kommo-nota:777', K.source_id_da_nota(l)
  end
end
