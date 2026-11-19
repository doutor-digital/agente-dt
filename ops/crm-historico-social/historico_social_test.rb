# frozen_string_literal: true

# Testes da parte PURA (sem Rails, sem rede, sem banco):  ruby ops/crm-historico-social/historico_social_test.rb
# (ou ops/crm-historico-social/testar.sh, que roda no contêiner do Chatwoot e não exige Ruby instalado no PC).
require 'minitest/autorun'
require_relative 'historico_social'

class HistoricoSocialTest < Minitest::Test
  S = HistoricoSocial
  PAGINA = '109875212111481'

  def msg(extra = {})
    { 'id' => 'm_1', 'created_time' => '2026-11-19T14:01:34+0000', 'from' => { 'id' => '5550001' }, 'message' => 'oi' }.merge(extra)
  end

  # ── nome ──
  def test_nome_padrao_so_john_doe_exato_ou_vazio
    assert S.nome_padrao?('John Doe')
    assert S.nome_padrao?('')
    assert S.nome_padrao?('   ')
    assert S.nome_padrao?(nil)
    refute S.nome_padrao?('Maria')
    refute S.nome_padrao?('John Doe Silva'), 'nome editado pela equipe não se toca'
    refute S.nome_padrao?('john doe'), 'só o padrão exato do Chatwoot'
    refute S.nome_padrao?(' John Doe'), 'com espaço já foi mexido por alguém'
  end

  # ── hora ──
  def test_hora_da_meta_sem_dois_pontos_no_fuso
    assert_equal Time.utc(2026, 11, 19, 14, 1, 34), S.hora('2026-11-19T14:01:34+0000')
    assert_equal Time.utc(2026, 11, 19, 17, 1, 34), S.hora('2026-11-19T14:01:34-0300')
    assert_nil S.hora('lixo')
    assert_nil S.hora(nil)
  end

  # ── conteúdo / anexos ──
  def test_texto_simples
    n, motivo = S.normalizar(msg, lado_pagina: PAGINA)
    assert_nil motivo
    assert_equal 'oi', n[:texto]
    assert n[:entrada]
    assert_equal 'm_1', n[:mid]
    assert_equal Time.utc(2026, 11, 19, 14, 1, 34), n[:ts]
  end

  def test_direcao_pela_pagina
    n, = S.normalizar(msg('from' => { 'id' => PAGINA }), lado_pagina: PAGINA)
    refute n[:entrada], 'quem escreve como a página é mensagem enviada'
    n, = S.normalizar(msg('from' => { 'id' => PAGINA }), lado_pagina: PAGINA.to_i) # id numérico na configuração
    refute n[:entrada]
  end

  def test_tipos_de_anexo
    t = S.method(:tipo_do_anexo)
    assert_equal :imagem, t.call('image_data' => { 'url' => 'x' })
    assert_equal :figurinha, t.call('image_data' => { 'render_as_sticker' => true })
    assert_equal :figurinha, t.call('image_data' => { 'sticker_id' => 1 })
    assert_equal :video, t.call('video_data' => {})
    assert_equal :audio, t.call('mime_type' => 'audio/mpeg', 'file_url' => 'x')
    assert_equal :imagem, t.call('mime_type' => 'image/jpeg')
    assert_equal :video, t.call('mime_type' => 'video/mp4')
    assert_equal :arquivo, t.call('mime_type' => 'application/pdf', 'file_url' => 'x')
    assert_equal :anexo, t.call('mime_type' => 'application/octet-stream')
    assert_equal :modelo, t.call('generic_template' => { 'title' => 'x' })
  end

  def test_anexo_vira_texto_sem_url
    m = msg('message' => '', 'attachments' => { 'data' => [{ 'image_data' => { 'url' => 'https://cdn.exemplo/expira?token=segredo' } }, { 'mime_type' => 'audio/mp4', 'file_url' => 'https://x' }] })
    n, = S.normalizar(m, lado_pagina: PAGINA)
    assert_equal "[imagem]\n[áudio]", n[:texto]
    refute_includes n[:texto], 'http'
    assert_equal %i[imagem audio], n[:tipos]
  end

  def test_texto_mais_anexo
    m = msg('message' => 'olha', 'attachments' => { 'data' => [{ 'image_data' => {} }] })
    n, = S.normalizar(m, lado_pagina: PAGINA)
    assert_equal "olha\n[imagem]", n[:texto]
  end

  def test_modelo_com_botoes_leva_o_titulo_da_clinica
    m = msg('from' => { 'id' => PAGINA }, 'message' => '', 'attachments' => { 'data' => [{ 'generic_template' => { 'title' => 'Agende sua avaliação', 'cta' => [{ 'url' => 'https://x' }] } }] })
    n, = S.normalizar(m, lado_pagina: PAGINA)
    assert_equal '[mensagem com botões] Agende sua avaliação', n[:texto]
    refute_includes n[:texto], 'http'
  end

  def test_figurinha_compartilhamento_story
    n, = S.normalizar(msg('message' => '', 'sticker' => 'https://x'), lado_pagina: PAGINA)
    assert_equal '[figurinha]', n[:texto]
    n, = S.normalizar(msg('message' => '', 'shares' => { 'data' => [{ 'link' => 'https://x' }] }), lado_pagina: PAGINA)
    assert_equal '[compartilhamento]', n[:texto]
    n, = S.normalizar(msg('message' => '', 'story' => { 'mention' => { 'link' => 'x' } }), lado_pagina: PAGINA)
    assert_equal '[menção em story]', n[:texto]
    n, = S.normalizar(msg('message' => 'que lindo', 'story' => { 'reply_to' => { 'link' => 'x' } }), lado_pagina: PAGINA)
    assert_equal "que lindo\n[resposta a story]", n[:texto]
    n, = S.normalizar(msg('message' => '', 'is_unsupported' => true), lado_pagina: PAGINA)
    assert_equal '[mensagem não suportada]', n[:texto]
  end

  def test_mensagem_vazia_e_motivos
    assert_equal [nil, :vazia], S.normalizar(msg('message' => ' '), lado_pagina: PAGINA)
    assert_equal [nil, :sem_id], S.normalizar(msg('id' => ''), lado_pagina: PAGINA)
    assert_equal [nil, :sem_hora], S.normalizar(msg('created_time' => 'x'), lado_pagina: PAGINA)
    assert_equal [nil, :sem_remetente], S.normalizar(msg('from' => nil), lado_pagina: PAGINA)
  end

  def test_nul_e_texto_gigante
    n, = S.normalizar(msg('message' => "a\u0000b"), lado_pagina: PAGINA)
    assert_equal 'ab', n[:texto]
    n, = S.normalizar(msg('message' => 'x' * 50_000), lado_pagina: PAGINA)
    assert_equal S::LIMITE_TEXTO, n[:texto].size
  end

  # ── ordem / decisão ──
  def itens(*ids_e_horas)
    ids_e_horas.map { |id, h| { mid: id, ts: Time.utc(2026, 11, 19, h, 0, 0) } }
  end

  def test_ordena_antigas_primeiro_e_mantem_a_ordem_no_empate
    # a Meta entrega da mais nova para a mais velha; b e c têm o MESMO segundo (c veio antes na resposta = c foi depois)
    cru = itens(['d', 12], ['c', 10], ['b', 10], ['a', 9])
    assert_equal %w[a b c d], S.ordenar_antigas_primeiro(cru).map { |m| m[:mid] }
  end

  def test_separar_existentes_corte_e_repetidas
    corte = Time.utc(2026, 11, 19, 11, 0, 0)
    r = S.separar(itens(['a', 9], ['b', 10], ['b', 10], ['viva', 12], ['jatem', 8]), existentes: Set.new(['jatem']), corte: corte)
    assert_equal %w[a b], r[:novas].map { |m| m[:mid] }
    assert_equal 2, r[:ja_existiam], 'jatem + a repetida de b'
    assert_equal 1, r[:pos_corte]
  end

  def test_mensagem_exatamente_no_corte_nao_entra
    corte = Time.utc(2026, 11, 19, 10, 0, 0)
    r = S.separar(itens(['no_corte', 10]), existentes: Set.new, corte: corte)
    assert_empty r[:novas]
    assert_equal 1, r[:pos_corte]
  end

  def test_idempotencia_segunda_rodada_nao_acha_nada_novo
    corte = Time.utc(2026, 11, 20)
    lote = itens(['a', 9], ['b', 10])
    primeira = S.separar(lote, existentes: Set.new, corte: corte)
    segunda = S.separar(lote, existentes: Set.new(primeira[:novas].map { |m| m[:mid] }), corte: corte)
    assert_equal 2, primeira[:novas].size
    assert_empty segunda[:novas]
    assert_equal 2, segunda[:ja_existiam]
  end

  # ── participantes ──
  def test_participante_externo_ignora_a_pagina
    lista = [{ 'id' => PAGINA, 'name' => 'Página' }, { 'id' => '5550001', 'name' => 'Maria', 'email' => 'x@facebook.com' }]
    assert_equal ['5550001', 'Maria', ''], S.participante_externo(lista, lado_pagina: PAGINA)
    assert_equal ['5550001', 'Maria', ''], S.participante_externo(lista.reverse, lado_pagina: PAGINA)
    assert_equal ['17', '', 'fulano'], S.participante_externo([{ 'id' => '99', 'username' => 'pagina' }, { 'id' => '17', 'username' => 'fulano' }], lado_pagina: '99')
    assert_nil S.participante_externo([{ 'id' => PAGINA }], lado_pagina: PAGINA)
    assert_nil S.participante_externo(nil, lado_pagina: PAGINA)
  end

  # ── Graph ──
  class HttpFalso
    attr_reader :urls

    def initialize(respostas)
      @respostas = respostas
      @urls = []
    end

    def call(uri)
      @urls << uri.to_s
      r = @respostas.shift
      raise r if r.is_a?(Class) && r <= Exception

      r
    end
  end

  def graph(respostas, **opc)
    http = HttpFalso.new(respostas)
    [S::Graph.new(base: 'https://graph.exemplo/v22.0', token: 'TOKEN_SECRETO', ritmo: 0, http: http, dorme: ->(_) {}, **opc), http]
  end

  def ok(corpo)
    [200, corpo.to_json]
  end

  def erro(codigo, status = 400, sub = nil)
    [status, { 'error' => { 'code' => codigo, 'error_subcode' => sub, 'message' => 'texto de paciente que não pode vazar' } }.to_json]
  end

  def test_graph_monta_url_com_token_e_nao_o_repete_em_paging_next
    g, http = graph([ok('data' => [], 'paging' => { 'next' => 'https://graph.exemplo/v22.0/x?after=2&access_token=TOKEN_SECRETO' }), ok('data' => [{ 'a' => 1 }])])
    vistos = []
    g.paginar('/conv', fields: 'id') { |d, _| vistos.concat(d) }
    assert_equal [{ 'a' => 1 }], vistos
    assert_includes http.urls[0], 'access_token=TOKEN_SECRETO'
    assert_equal 1, http.urls[1].scan('access_token').size, 'o token do paging.next não pode ser duplicado'
  end

  def test_graph_transitorio_tenta_de_novo_e_passa
    g, = graph([erro(2, 500), erro(1, 500), ok('ok' => true)])
    assert_equal({ 'ok' => true }, g.get('/x'))
    assert_equal 3, g.chamadas
  end

  def test_sql_nome_padrao
    sql = S.sql_nome_padrao('contacts.name')
    assert_includes sql, "contacts.name = 'John Doe'"
    assert_includes sql, 'btrim(contacts.name'
  end

  def test_graph_corpo_ilegivel_com_200_repete_em_vez_de_devolver_nil
    g, = graph([[200, '<html>proxy</html>'], [200, ''], ok('ok' => 1)])
    assert_equal({ 'ok' => 1 }, g.get('/x'))
  end

  def test_graph_erro_de_rede_conta_como_transitorio
    g, = graph([Timeout::Error, ok('ok' => 1)])
    assert_equal({ 'ok' => 1 }, g.get('/x'))
  end

  def test_graph_token_recusado_para_na_hora
    g, = graph([erro(190, 400), ok('nunca' => 1)])
    assert_raises(S::Parar) { g.get('/x') }
    assert_equal 1, g.chamadas
  end

  def test_graph_permissao_e_limite_param
    [230, 10, 200].each do |cod|
      g, = graph([erro(cod, 403)])
      assert_raises(S::Parar, "código #{cod}") { g.get('/x') }
    end
  end

  def test_graph_limite_espera_e_tenta_de_novo_antes_de_parar
    esperas = []
    http = HttpFalso.new([erro(4, 400), erro(4, 400), ok('ok' => 1)])
    g = S::Graph.new(base: 'https://graph.exemplo/v22.0', token: 'T', ritmo: 0, http: http, dorme: ->(s) { esperas << s }, espera_limite: 90)
    assert_equal({ 'ok' => 1 }, g.get('/x'))
    assert_equal [90, 180], esperas, 'espera de minutos, crescente — não martela a Meta'
  end

  def test_graph_limite_que_nao_passa_para_a_rodada
    g, = graph([erro(613, 400), erro(613, 400), erro(613, 400)])
    assert_raises(S::Parar) { g.get('/x') }
  end

  def test_graph_pedido_invalido_nao_repete_e_nao_para_a_rodada
    g, = graph([erro(100, 400, 33), ok('seguinte' => 1)])
    e = assert_raises(S::ErroDaMeta) { g.get('/x') }
    assert_equal 100, e.codigo
    assert_equal({ 'seguinte' => 1 }, g.get('/y'))
  end

  def test_graph_para_apos_falhas_seguidas
    respostas = Array.new(30) { erro(2, 500) }
    g, = graph(respostas, tentativas: 2, falhas_seguidas_max: 3)
    assert_raises(S::ErroDaMeta) { g.get('/a') }
    assert_raises(S::ErroDaMeta) { g.get('/b') }
    assert_raises(S::Parar) { g.get('/c') }
  end

  def test_sucesso_zera_as_falhas_seguidas
    g, = graph([erro(2, 500), erro(2, 500), ok('a' => 1), erro(2, 500), erro(2, 500), ok('b' => 1)], tentativas: 2, falhas_seguidas_max: 2)
    assert_raises(S::ErroDaMeta) { g.get('/1') }
    assert_equal({ 'a' => 1 }, g.get('/2'))
    assert_raises(S::ErroDaMeta) { g.get('/3') }
    assert_equal({ 'b' => 1 }, g.get('/4'))
  end

  def test_mensagem_de_erro_nao_carrega_texto_nem_token
    g, = graph([erro(100, 400)])
    e = assert_raises(S::ErroDaMeta) { g.get('/x') }
    refute_includes e.message, 'paciente'
    refute_includes e.message, 'TOKEN_SECRETO'
  end

  # ── FonteMeta ──
  def test_fonte_messenger_pagina_as_mensagens_ate_o_fim
    primeira = { 'id' => 't_1', 'messages' => { 'data' => [{ 'id' => 'm3' }, { 'id' => 'm2' }], 'paging' => { 'next' => 'https://graph.exemplo/v22.0/p2?access_token=TOKEN_SECRETO' } } }
    g, http = graph([ok(primeira), ok('data' => [{ 'id' => 'm1' }], 'paging' => {})])
    f = S::FonteMeta.new(canal: :messenger, graph: g, lado_pagina: PAGINA)
    lista, truncada = f.mensagens('t_1')
    assert_equal %w[m3 m2 m1], lista.map { |m| m['id'] }
    refute truncada
    assert_includes URI.decode_www_form_component(http.urls[0]), 'limit(100)'
  end

  def test_fonte_instagram_marca_conversa_de_20_como_possivelmente_truncada
    vinte = (1..20).map { |i| { 'id' => "i#{i}" } }
    g, http = graph([ok('id' => 'c', 'messages' => { 'data' => vinte, 'paging' => { 'next' => 'https://graph.exemplo/v24.0/c/messages?after=x&access_token=TOKEN_SECRETO' } })])
    f = S::FonteMeta.new(canal: :instagram, graph: g, lado_pagina: '17841')
    lista, truncada = f.mensagens('c')
    assert_equal 20, lista.size
    assert truncada
    assert_includes URI.decode_www_form_component(http.urls[0]), 'limit(20)'
    assert_equal 1, http.urls.size, 'Instagram: paging.next devolve erro 4/1349210 — não se segue'
  end

  def test_fonte_messenger_marca_truncada_quando_estoura_o_teto_de_paginas
    paginas = Array.new(S::MAX_PAGINAS_DE_MENSAGENS) { |i| ok('data' => [{ 'id' => "m#{i}" }], 'paging' => { 'next' => 'https://graph.exemplo/v22.0/p?access_token=T' }) }
    g, = graph(paginas)
    f = S::FonteMeta.new(canal: :messenger, graph: g, lado_pagina: PAGINA)
    # a 1ª resposta traz `messages` aninhado
    paginas[0] = ok('id' => 't', 'messages' => { 'data' => [{ 'id' => 'm0' }], 'paging' => { 'next' => 'https://graph.exemplo/v22.0/p?access_token=T' } })
    lista, truncada = f.mensagens('t')
    assert_equal S::MAX_PAGINAS_DE_MENSAGENS, lista.size
    assert truncada, 'sobrou página depois do teto: não pode parecer completa'
  end

  def test_fonte_lista_conversas_com_limite
    g, = graph([ok('data' => [{ 'id' => 'a' }, { 'id' => 'b' }, { 'id' => 'c' }])])
    f = S::FonteMeta.new(canal: :messenger, graph: g, lado_pagina: PAGINA)
    ids = []
    f.conversas(limite: 2) { |c| ids << c['id'] }
    assert_equal %w[a b], ids
  end

  def test_participante_por_usuario_devolve_o_nome_da_conversa_do_psid
    resp = ok('data' => [{ 'id' => 't_1', 'participants' => { 'data' => [{ 'id' => PAGINA, 'name' => 'Página' }, { 'id' => '5550001', 'name' => 'Maria Real' }] } }])
    g, http = graph([resp])
    f = S::FonteMeta.new(canal: :messenger, graph: g, lado_pagina: PAGINA)
    assert_equal ['5550001', 'Maria Real', ''], f.participante_por_usuario('5550001')
    assert_includes http.urls[0], 'user_id=5550001'
  end

  def test_perfil_negado_por_consentimento_230_nao_derruba_a_rodada
    # o Chatwoot ignora o 230 em Instagram::MessageText#handle_error_response; antes disto o importador parava tudo no mesmo ponto
    [230, 10, 200, 3, 9010, 100].each do |cod|
      g, = graph([erro(cod, 400), ok('name' => 'Ana', 'username' => 'ana')])
      f = S::FonteMeta.new(canal: :instagram, graph: g, lado_pagina: '17841')
      assert_nil f.perfil_instagram('1'), "código #{cod}: segue sem o nome"
      assert_equal({ 'name' => 'Ana', 'username' => 'ana' }, f.perfil_instagram('2'), 'e a próxima pessoa continua sendo lida')
    end
  end

  def test_perfil_com_token_recusado_ainda_para
    g, = graph([erro(190, 400)])
    f = S::FonteMeta.new(canal: :instagram, graph: g, lado_pagina: '17841')
    assert_raises(S::Parar) { f.perfil_instagram('1') }
  end

  def test_230_fora_do_perfil_continua_parando
    g, = graph([erro(230, 403)])
    assert_raises(S::Parar) { g.get('/x') }
  end

  # ── corte ──
  def test_corte_padrao_e_a_criacao_da_caixa
    inicio = Time.utc(2026, 11, 20, 12)
    criacao = Time.utc(2026, 11, 19, 13, 49)
    assert_equal criacao, S.resolver_corte(informado: nil, criacao_da_caixa: criacao, inicio: inicio)
  end

  def test_corte_informado_depois_de_inicio_menos_15_min_e_recusado
    inicio = Time.utc(2026, 11, 20, 12)
    assert_raises(ArgumentError) { S.resolver_corte(informado: inicio - 600, criacao_da_caixa: inicio - 86_400, inicio: inicio) }
    assert_raises(ArgumentError) { S.resolver_corte(informado: inicio, criacao_da_caixa: inicio - 86_400, inicio: inicio) }
    ok = inicio - (15 * 60)
    assert_equal ok, S.resolver_corte(informado: ok, criacao_da_caixa: inicio - 86_400, inicio: inicio), 'exatamente 15 min vale'
  end

  # ── cota da Meta ──
  def com_cabecalho(resp, app: nil, biz: nil)
    [resp[0], resp[1], { 'x-app-usage' => app, 'x-business-use-case-usage' => biz }]
  end

  def test_cota_para_antes_de_estourar_no_messenger
    biz = { '109' => [{ 'call_count' => 85, 'total_cputime' => 3, 'total_time' => 2 }] }.to_json
    g, = graph([com_cabecalho(ok('ok' => 1), biz: biz)])
    e = assert_raises(S::Parar) { g.get('/x') }
    assert_includes e.message, '85%'
    assert_equal 85, g.uso_maximo
  end

  def test_cota_para_antes_de_estourar_no_instagram
    g, = graph([com_cabecalho(ok('ok' => 1), app: { 'call_volume' => 90, 'cpu_time' => 1 }.to_json)])
    assert_raises(S::Parar) { g.get('/x') }
  end

  def test_cota_acima_de_60_desacelera_e_abaixo_nao
    esperas = []
    http = HttpFalso.new([com_cabecalho(ok('a' => 1), app: { 'call_volume' => 65, 'cpu_time' => 1 }.to_json), com_cabecalho(ok('b' => 1), app: { 'call_volume' => 10 }.to_json)])
    g = S::Graph.new(base: 'https://graph.exemplo/v22.0', token: 'T', ritmo: 0, http: http, dorme: ->(s) { esperas << s }, pausa_por_uso: 60)
    g.get('/1')
    g.get('/2')
    assert_equal [60], esperas, 'só a chamada com 65% espera'
    assert_equal 65, g.uso_maximo
  end

  def test_sem_cabecalho_de_uso_nao_quebra
    g, = graph([ok('ok' => 1)])
    assert_equal({ 'ok' => 1 }, g.get('/x'))
    assert_equal 0, g.uso_maximo
  end

  def test_perfil_instagram_negado_devolve_nil
    g, = graph([erro(100, 400, 33)])
    f = S::FonteMeta.new(canal: :instagram, graph: g, lado_pagina: '17841')
    assert_nil f.perfil_instagram('123')
  end
end
