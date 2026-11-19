# frozen_string_literal: true

# Biblioteca da importação do histórico do Instagram Direct e do Messenger para o CRM (Chatwoot) — PURA: não usa Rails nem o banco,
# por isso se testa com `ruby` puro (historico_social_test.rb). Nada aqui grava em lugar nenhum; só lê da Meta (Graph) e decide.
#
# Regra de privacidade: nada daqui imprime nome, @usuário, texto, token ou URL (a URL da Meta carrega o token). Erros saem só com
# código/subcódigo da Meta. Quem chama também só imprime ids e contagens.
require 'json'
require 'net/http'
require 'openssl'
require 'set'
require 'time'
require 'tempfile'
require 'timeout'
require 'uri'
require 'zlib'

module HistoricoSocial
  NOME_PADRAO = 'John Doe' # o nome que o Chatwoot põe quando a Meta nega o perfil (falta «Business Asset User Profile Access»)
  ETIQUETA = 'historico'
  MARCA_CONVERSA = 'meta_conversation_id' # additional_attributes da conversa importada: guarda o id da conversa na Meta
  LIMITE_TEXTO = 20_000

  ROTULOS = {
    imagem: '[imagem]', video: '[vídeo]', audio: '[áudio]', arquivo: '[arquivo]', figurinha: '[figurinha]',
    anexo: '[anexo]', compartilhamento: '[compartilhamento]', story_mencao: '[menção em story]',
    story_resposta: '[resposta a story]', nao_suportada: '[mensagem não suportada]'
  }.freeze

  module_function

  # «John Doe» exato ou vazio: o único nome que a importação/rotina aceita trocar (nome editado pela equipe não se toca).
  def nome_padrao?(nome)
    n = nome.to_s
    n.strip.empty? || n == NOME_PADRAO
  end

  MARGEM_DO_CORTE = 15 * 60 # o corte nunca pode passar de «início − 15 min»

  # Corte = a partir de quando a mensagem é «viva» (o webhook entrega) e NÃO se importa. Padrão: o dia/hora em que a CAIXA foi criada
  # (webhook atrasado da Meta repete por horas: com corte curto, a mensagem some no Instagram — o Chatwoot a acha «já existente» — e
  # duplica no Messenger). `informado` (--corte) só vale se não passar de início − 15 min.
  def resolver_corte(informado:, criacao_da_caixa:, inicio:)
    teto = inicio - MARGEM_DO_CORTE
    return criacao_da_caixa.utc if informado.nil?

    raise ArgumentError, "corte #{informado.utc.iso8601} é depois de início − 15 min (#{teto.utc.iso8601}): recusado" if informado > teto

    informado.utc
  end

  # Quem a rotina dos «John Doe» consulta nesta rodada: os mais NOVOS primeiro (metade da cota) e o resto por sorteio que muda a cada
  # rodada (`slot`) — contato que a Meta não nomeia nunca prende a fila dos mais antigos.
  def escolher_candidatos(escopo, maximo, slot)
    novos = (maximo / 2.0).ceil
    ids_novos = escopo.reorder('contacts.id DESC').limit(novos).pluck('contacts.id')
    resto = escopo.where.not(id: ids_novos).reorder(Arel.sql("md5(contacts.id::text || '#{slot.to_i}')")).limit(maximo - ids_novos.size).pluck('contacts.id')
    ids_novos + resto
  end

  # Condição SQL «nome ainda é o padrão»: espelha nome_padrao? (John Doe exato, ou só espaço/tab/quebra de linha).
  def sql_nome_padrao(coluna)
    "(#{coluna} = '#{NOME_PADRAO}' OR btrim(#{coluna}, E' \\t\\r\\n') = '')"
  end

  def limpar(texto)
    texto.to_s.delete("\u0000").strip[0, LIMITE_TEXTO]
  end

  # Meta: "2026-11-19T14:01:34+0000" (sem dois-pontos no fuso). Devolve Time UTC, ou nil se não der para ler.
  def hora(texto)
    Time.strptime(texto.to_s, '%Y-%m-%dT%H:%M:%S%z').utc
  rescue ArgumentError
    nil
  end

  # Que tipo de anexo é (só o TIPO — a URL da Meta expira e não é baixada nem guardada).
  def tipo_do_anexo(anexo)
    return :modelo if anexo['generic_template']

    img = anexo['image_data']
    return :figurinha if img.is_a?(Hash) && (img['render_as_sticker'] || img['sticker_id'])
    return :imagem if img
    return :video if anexo['video_data']
    return :audio if anexo['audio_data']

    case anexo['mime_type'].to_s
    when %r{\Aimage/} then :imagem
    when %r{\Avideo/} then :video
    when %r{\Aaudio/} then :audio
    else (anexo['file_url'] || anexo['name']) ? :arquivo : :anexo
    end
  end

  TIPOS_BAIXAVEIS = %i[imagem figurinha audio video arquivo].freeze

  def hash_ou_vazio(x)
    x.is_a?(Hash) ? x : {}
  end

  # Mídia que a Meta ACABOU de entregar (a URL vale por pouco tempo): tipo, URL (só em memória — nunca vai para log), mime/nome/tamanho
  # que a Graph informa. `url` nil = a Meta não mandou link: fica o rótulo.
  def midia_do_anexo(anexo, tipo)
    url = [hash_ou_vazio(anexo['image_data'])['url'], hash_ou_vazio(anexo['video_data'])['url'], hash_ou_vazio(anexo['audio_data'])['url'], anexo['file_url']]
          .find { |u| u.is_a?(String) && !u.empty? }
    { tipo: tipo, url: url, mime: anexo['mime_type'].to_s, nome: limpar(anexo['name'])[0, 200], tamanho: anexo['size'].is_a?(Numeric) ? anexo['size'].to_i : nil }
  end

  # A mensagem em PARTES, na ordem: [{ rotulo:, midia: nil|{...}, texto: true|false }], mais os tipos (para a contagem do resumo).
  # `rotulo` é o texto da parte («oi», «[imagem]», título de modelo…); parte com `midia` e URL pode virar anexo de verdade e então perde o rótulo.
  def partes_da_mensagem(msg)
    partes = []
    tipos = []
    texto = limpar(msg['message'])
    partes << { rotulo: texto, midia: nil, texto: true } unless texto.empty?
    anexos = msg.dig('attachments', 'data')
    (anexos.is_a?(Array) ? anexos : []).each do |a|
      next unless a.is_a?(Hash)

      t = tipo_do_anexo(a)
      tipos << t
      if t == :modelo
        partes << { rotulo: modelo_em_texto(a), midia: nil, texto: false }
      else
        partes << { rotulo: ROTULOS.fetch(t), midia: TIPOS_BAIXAVEIS.include?(t) ? midia_do_anexo(a, t) : nil, texto: false }
      end
    end
    if msg['sticker'] && !tipos.include?(:figurinha)
      tipos << :figurinha
      partes << { rotulo: ROTULOS[:figurinha], midia: { tipo: :figurinha, url: msg['sticker'].is_a?(String) && !msg['sticker'].empty? ? msg['sticker'] : nil, mime: '', nome: '', tamanho: nil }, texto: false }
    end
    compartilhamentos = msg.dig('shares', 'data')
    (compartilhamentos.is_a?(Array) ? compartilhamentos : []).each do
      tipos << :compartilhamento
      partes << { rotulo: ROTULOS[:compartilhamento], midia: nil, texto: false }
    end
    story = msg['story']
    if story.is_a?(Hash)
      if story['mention']
        tipos << :story_mencao
        partes << { rotulo: ROTULOS[:story_mencao], midia: nil, texto: false }
      end
      if story['reply_to']
        tipos << :story_resposta
        partes << { rotulo: ROTULOS[:story_resposta], midia: nil, texto: false }
      end
    end
    if partes.empty? && msg['is_unsupported'] == true
      tipos << :nao_suportada
      partes << { rotulo: ROTULOS[:nao_suportada], midia: nil, texto: false }
    end
    [partes, tipos]
  end

  # Texto final da mensagem: todos os rótulos, menos os das partes que viraram anexo (`anexadas` = índices). nil = só mídia, sem texto.
  def compor(partes, anexadas = [])
    t = partes.each_with_index.reject { |_, i| anexadas.include?(i) }.map { |p, _| p[:rotulo] }.join("\n")
    t.empty? ? nil : t
  end

  # Texto que vai para o CRM + os tipos achados (para a contagem do resumo). `nil` no texto = nada a gravar (mensagem vazia/apagada).
  # Mensagem com botões (modelo da própria página) leva o título do modelo, que é texto da clínica.
  def conteudo(msg)
    partes, tipos = partes_da_mensagem(msg)
    [partes.empty? ? nil : compor(partes), tipos]
  end

  def modelo_em_texto(anexo)
    titulo = limpar(anexo.dig('generic_template', 'title'))[0, 300]
    titulo.empty? ? '[mensagem com botões]' : "[mensagem com botões] #{titulo}"
  end

  # Mensagem crua da Meta -> hash pronto. Devolve [hash, nil] ou [nil, :motivo] (:vazia, :sem_remetente, :sem_id, :sem_hora).
  # `partes` mantém a estrutura (para anexar mídia depois); `midias` = [{ idx:, tipo:, url:, mime:, nome:, tamanho: }] só das baixáveis.
  def normalizar(msg, lado_pagina:)
    return [nil, :sem_id] if msg['id'].to_s.empty?

    ts = hora(msg['created_time'])
    return [nil, :sem_hora] unless ts

    de = msg.dig('from', 'id').to_s
    return [nil, :sem_remetente] if de.empty?

    partes, tipos = partes_da_mensagem(msg)
    return [nil, :vazia] if partes.empty?

    midias = partes.each_with_index.select { |p, _| p[:midia] }.map { |p, i| p[:midia].merge(idx: i) }
    [{ mid: msg['id'].to_s, ts: ts, entrada: de != lado_pagina.to_s, texto: compor(partes), partes: partes, midias: midias, tipos: tipos }, nil]
  end

  # A Meta devolve da mais nova para a mais velha; o CRM quer a mais velha primeiro. Empate de segundo mantém a ordem real.
  def ordenar_antigas_primeiro(itens)
    itens.reverse.each_with_index.sort_by { |m, i| [m[:ts], i] }.map(&:first)
  end

  # Decide o que entra: pula o que já existe (source_id) e o que é mais novo que o CORTE (mensagem «viva» — o webhook entrega; se a
  # importação gravasse antes dele, o Chatwoot acharia que já existe e a mensagem nova nunca apareceria para a equipe).
  def separar(itens, existentes:, corte:)
    r = { novas: [], ja_existiam: 0, pos_corte: 0 }
    vistos = {}
    itens.each do |m|
      next (r[:ja_existiam] += 1) if existentes.include?(m[:mid]) || vistos[m[:mid]]

      vistos[m[:mid]] = true
      next (r[:pos_corte] += 1) if corte && m[:ts] >= corte

      r[:novas] << m
    end
    r
  end

  # Os dois participantes de uma conversa -> o que NÃO é a página/conta. [id, nome, usuario] ou nil.
  def participante_externo(participantes, lado_pagina:)
    lista = participantes.is_a?(Array) ? participantes : []
    p = lista.find { |x| x.is_a?(Hash) && x['id'].to_s != lado_pagina.to_s && !x['id'].to_s.empty? }
    return nil unless p

    [p['id'].to_s, limpar(p['name'])[0, 255], limpar(p['username'])[0, 255]]
  end

  # ─── Graph ───────────────────────────────────────────────────────────────────────────────────────────────────────

  class Parar < StandardError; end # erro que não adianta repetir (token, permissão, limite estourado): a rodada para

  class ErroDaMeta < StandardError # não carrega mensagem da Meta (pode ter texto de paciente) — só código
    attr_reader :codigo, :subcodigo, :http

    def initialize(codigo, subcodigo = nil, http = nil)
      @codigo = codigo
      @subcodigo = subcodigo
      @http = http
      super("Meta: código #{codigo.inspect} subcódigo #{subcodigo.inspect} http #{http.inspect}")
    end
  end

  # Cliente mínimo da Graph. `http` é injetável nos testes: responde `call(uri) -> [status, corpo_string]`.
  class Graph
    CODIGOS_DE_TOKEN = [102, 190].freeze            # token vencido/inválido: não adianta repetir
    CODIGOS_DE_PERMISSAO = [3, 10, 200, 230, 299].freeze
    CODIGOS_DE_LIMITE = [4, 17, 32, 613, 80_001, 80_002, 80_003, 80_006, 80_008].freeze
    CODIGOS_TRANSITORIOS = [1, 2, 341].freeze

    attr_reader :chamadas

    USO_PAUSAR_EM = 60  # % da cota (maior dos contadores da Meta): daqui para cima, espera antes da próxima chamada
    USO_PARAR_EM = 80   # % da cota: para a rodada ANTES de estourar (o token é o mesmo do atendimento ao vivo)

    attr_reader :uso_maximo, :cabecalhos_de_uso

    def initialize(base:, token:, ritmo: 0.7, http: nil, dorme: nil, tentativas: 3, falhas_seguidas_max: 5, espera_limite: 90, pausa_por_uso: 60)
      @base = base.chomp('/')
      @token = token
      @ritmo = ritmo
      @http = http || method(:http_real)
      @dorme = dorme || ->(s) { sleep(s) }
      @tentativas = tentativas
      @falhas_seguidas_max = falhas_seguidas_max
      @espera_limite = espera_limite
      @pausa_por_uso = pausa_por_uso
      @uso_maximo = 0
      @cabecalhos_de_uso = Set.new
      @pausas_seguidas = 0
      @falhas_seguidas = 0
      @chamadas = 0
    end

    # caminho relativo ("/{id}") com parâmetros, ou URL inteira (paging.next, que já leva o token)
    # `tolerar_negado`: permissão/consentimento negado (230, 10, 200, 3…) vira ErroDaMeta (o chamador segue sem o dado) em vez de Parar.
    def get(caminho, params = {}, tolerar_negado = false)
      uri = montar(caminho, params)
      tent = 0
      loop do
        tent += 1
        @dorme.call(@ritmo) if @ritmo.positive?
        @chamadas += 1
        status, corpo, cabecalhos = chamar(uri)
        json = ler(corpo)
        controlar_uso!(cabecalhos)
        erro = json.is_a?(Hash) ? json['error'] : nil
        if erro.nil? && status.to_i < 400 && json.is_a?(Hash)
          @falhas_seguidas = 0
          return json
        end
        codigo = erro.is_a?(Hash) ? erro['code'] : nil
        sub = erro.is_a?(Hash) ? erro['error_subcode'] : nil
        classificar!(codigo, sub, status, ilegivel: json.nil?, tolerar_negado: tolerar_negado)
        # transitório (ou 5xx/timeout) e limite de chamadas: tenta de novo com espera crescente (o limite espera MUITO mais: minutos);
        # esgotou as tentativas, conta uma falha seguida — e falhas seguidas demais param a rodada inteira
        if tent >= @tentativas
          @falhas_seguidas += 1
          raise Parar, "limite de chamadas da Meta (código #{codigo}) persistiu — paro e deixo para depois" if limite?(codigo)
          raise Parar, "#{@falhas_seguidas_max} falhas seguidas da Meta — paro (último: código #{codigo.inspect})" if @falhas_seguidas >= @falhas_seguidas_max

          raise ErroDaMeta.new(codigo, sub, status)
        end
        @dorme.call(limite?(codigo) ? @espera_limite * tent : 3 * tent)
      end
    end

    # Segue paging.next até acabar (ou até `max_paginas`). Entrega cada `data` ao bloco.
    def paginar(caminho, params = {}, max_paginas = 200)
      pagina = get(caminho, params)
      n = 1
      loop do
        yield(pagina['data'] || [], pagina)
        prox = pagina.dig('paging', 'next')
        break if prox.to_s.empty? || n >= max_paginas

        pagina = get(prox)
        n += 1
      end
    end

    private

    def montar(caminho, params)
      uri = caminho.start_with?('http') ? URI(caminho) : URI("#{@base}/#{caminho.sub(%r{\A/}, '')}")
      if params.any? || !uri.query.to_s.include?('access_token=')
        q = URI.decode_www_form(uri.query.to_s) + params.map { |k, v| [k.to_s, v.to_s] }
        q << ['access_token', @token] unless q.assoc('access_token')
        uri.query = URI.encode_www_form(q)
      end
      uri
    end

    def ler(corpo)
      JSON.parse(corpo.to_s)
    rescue JSON::ParserError
      nil
    end

    def chamar(uri)
      @http.call(uri)
    rescue Timeout::Error, SystemCallError, SocketError, IOError, OpenSSL::SSL::SSLError
      [599, '']
    end

    def limite?(codigo)
      CODIGOS_DE_LIMITE.include?(codigo)
    end

    # Maior contador de uso (%) nos cabeçalhos «*usage*» da Meta: x-app-usage {call_volume, cpu_time}, x-business-use-case-usage
    # {id: [{call_count, total_cputime, total_time}]} e x-page-usage {call_count, total_cputime, total_time}. O Instagram (login do Instagram)
    # mediu 0% em tudo: `cabecalhos_de_uso` guarda QUAIS cabeçalhos vieram, para o resumo mostrar se algum veio. Passou de USO_PARAR_EM: para ANTES de estourar.
    def controlar_uso!(cab)
      return unless cab.is_a?(Hash)

      usos = []
      cab.each do |nome, valor|
        next unless nome.to_s.downcase.include?('usage') && !valor.to_s.empty?

        @cabecalhos_de_uso << nome.to_s.downcase
        j = ler(valor)
        next unless j.is_a?(Hash)

        j.each_value do |v|
          (v.is_a?(Array) ? v : [j]).each do |x|
            next unless x.is_a?(Hash)

            %w[call_count total_cputime total_time call_volume cpu_time].each { |k| usos << x[k].to_f if x[k].is_a?(Numeric) }
          end
        end
      end
      uso = usos.max.to_f
      @uso_maximo = uso if uso > @uso_maximo
      raise Parar, "uso da cota da Meta em #{uso.round}% — paro antes de estourar; retome mais tarde (de preferência à noite)" if uso >= USO_PARAR_EM

      if uso >= USO_PAUSAR_EM
        @pausas_seguidas += 1
        raise Parar, "cota da Meta segue acima de #{USO_PAUSAR_EM}% depois de #{@pausas_seguidas} pausas — paro" if @pausas_seguidas > 30

        @dorme.call(@pausa_por_uso)
      else
        @pausas_seguidas = 0
      end
    end

    def classificar!(codigo, _sub, status, ilegivel: false, tolerar_negado: false)
      return if ilegivel || CODIGOS_TRANSITORIOS.include?(codigo) || limite?(codigo) || status.to_i >= 500 # corpo que não é JSON (proxy/CDN): repete
      raise Parar, "token da Meta recusado (código #{codigo})" if CODIGOS_DE_TOKEN.include?(codigo)
      raise Parar, "permissão da Meta negada (código #{codigo})" if CODIGOS_DE_PERMISSAO.include?(codigo) && !tolerar_negado
      raise ErroDaMeta.new(codigo, nil, status) # pedido inválido/objeto sumiu: não adianta repetir, o chamador pula essa conversa
    end

    def http_real(uri)
      Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 15, read_timeout: 60) do |h|
        r = h.request(Net::HTTP::Get.new(uri))
        [r.code.to_i, r.body, r.each_header.select { |nome, _| nome.to_s.downcase.include?('usage') }.to_h]
      end
    end
  end

  # ─── Mídia ───────────────────────────────────────────────────────────────────────────────────────────────────────

  class ErroMidia < StandardError # só o MOTIVO (nunca a URL, que tem token da CDN)
    attr_reader :motivo

    def initialize(motivo)
      @motivo = motivo
      super("mídia: #{motivo}")
    end
  end

  EXTENSOES = {
    'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp', 'image/heic' => 'heic',
    'video/mp4' => 'mp4', 'video/quicktime' => 'mov', 'video/webm' => 'webm', 'audio/mpeg' => 'mp3', 'audio/mp4' => 'm4a',
    'audio/aac' => 'aac', 'audio/ogg' => 'ogg', 'audio/wav' => 'wav', 'audio/webm' => 'webm', 'application/pdf' => 'pdf'
  }.freeze
  TIPOS_RECUSADOS = %w[text/html application/json application/xhtml+xml].freeze
  TIPOS_GENERICOS = ['', 'application/octet-stream', 'binary/octet-stream'].freeze # «não sei»: vale o mime que a Graph informou

  # Baixa a mídia NA HORA (a URL da Meta acabou de ser gerada). Teto de tamanho por arquivo, prazo total por download, só https e só
  # hosts da Meta (a URL vem de fora: não é para o importador ir buscar o que não é da Meta). Falha = ErroMidia(motivo), nunca derruba a rodada.
  class Baixador
    HOSTS_DA_META = %w[fbcdn.net fbsbx.com cdninstagram.com facebook.com instagram.com].freeze

    # `permitir`: lambda(uri) -> true libera o host (SÓ nos testes locais; em produção vale a lista da Meta)
    def initialize(max_bytes:, prazo: 60, abrir: 10, ler: 30, permitir: nil)
      @max = max_bytes
      @prazo = prazo
      @abrir = abrir
      @ler = ler
      @permitir = permitir
    end

    def host_permitido?(uri)
      return true if @permitir&.call(uri)

      uri.is_a?(URI::HTTPS) && HOSTS_DA_META.any? { |h| uri.host == h || uri.host.to_s.end_with?(".#{h}") }
    end

    # O tipo que a CDN respondeu tem de bater com o que a Graph disse (página de erro/HTML nunca vira «imagem»). Octet-stream/vazio usa o mime da Graph.
    def tipo_efetivo(ct, mime_graph)
      ct = ct.to_s.split(';').first.to_s.strip.downcase
      ct = mime_graph.to_s.split(';').first.to_s.strip.downcase if TIPOS_GENERICOS.include?(ct)
      ct
    end

    def tipo_confere?(ct, tipo)
      return false if TIPOS_RECUSADOS.include?(ct)
      return tipo == :arquivo if TIPOS_GENERICOS.include?(ct) # arquivo sem tipo conhecido vale (nome/extensão); imagem/áudio/vídeo sem tipo não

      case tipo
      when :imagem, :figurinha then ct.start_with?('image/')
      when :video then ct.start_with?('video/')
      when :audio then ct.start_with?('audio/') || ct.start_with?('video/')
      else true
      end
    end

    # => { arquivo: Tempfile (posicionado no início; quem chama fecha), content_type:, bytes: }
    def baixar(url, tipo:, mime_graph: '')
      uri = alvo(url)
      limite = Time.now + @prazo
      tmp = Tempfile.new(['hs-midia', '.bin'])
      tmp.binmode
      redirecionamentos = 0
      loop do
        proximo = nil
        Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: @abrir, read_timeout: @ler) do |h|
          h.request(Net::HTTP::Get.new(uri)) do |r|
            case r
            when Net::HTTPRedirection
              proximo = r['location']
            when Net::HTTPSuccess
              ct = tipo_efetivo(r['content-type'], mime_graph)
              raise ErroMidia, :tipo unless tipo_confere?(ct, tipo)
              raise ErroMidia, :tamanho if r['content-length'].to_i > @max

              total = 0
              r.read_body do |pedaco|
                total += pedaco.bytesize
                raise ErroMidia, :tamanho if total > @max
                raise ErroMidia, :tempo if Time.now > limite

                tmp.write(pedaco)
              end
              raise ErroMidia, :vazio if total.zero? # URL vencida costuma responder 200/204 sem corpo: anexo de 0 byte não vale
              tmp.flush
              tmp.rewind
              return { arquivo: tmp, content_type: ct, bytes: total }
            else
              raise ErroMidia, :http
            end
          end
        end
        redirecionamentos += 1
        raise ErroMidia, :http if proximo.to_s.empty? || redirecionamentos > 3

        uri = alvo(URI.join(uri, proximo).to_s)
      end
    rescue ErroMidia
      tmp&.close!
      raise
    rescue Timeout::Error, Net::OpenTimeout, Net::ReadTimeout
      tmp&.close!
      raise ErroMidia, :tempo
    rescue Errno::ENOSPC
      tmp&.close!
      raise ErroMidia, :disco # o disco do servidor encheu: motivo próprio (não é falha de rede)
    rescue SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse, Net::ProtocolError, URI::Error, Zlib::Error
      tmp&.close!
      raise ErroMidia, :rede
    end

    # Tamanho (bytes) pelo cabeçalho, SEM baixar — para a estimativa do seco. nil se não souber.
    def medir(url)
      uri = alvo(url)
      4.times do
        proximo = nil
        tamanho = nil
        Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == 'https', open_timeout: @abrir, read_timeout: @ler) do |h|
          r = h.request(Net::HTTP::Head.new(uri))
          case r
          when Net::HTTPRedirection then proximo = r['location']
          when Net::HTTPSuccess then tamanho = r['content-length']&.to_i
          end
        end
        return tamanho unless proximo

        uri = alvo(URI.join(uri, proximo).to_s)
      end
      nil
    rescue ErroMidia, Timeout::Error, SocketError, SystemCallError, IOError, OpenSSL::SSL::SSLError, Net::ProtocolError, URI::Error
      nil
    end

    private

    def alvo(url)
      uri = URI.parse(url.to_s)
      raise ErroMidia, :host unless uri.host && host_permitido?(uri)

      uri
    end
  end

  # tipo do Attachment do Chatwoot (image/audio/video/file) pelo que a CDN respondeu; áudio da Meta que vem como video/mp4 continua áudio.
  def tipo_do_chatwoot(ct, tipo)
    return :audio if tipo == :audio
    return :image if tipo == :figurinha || ct.start_with?('image/')
    return :audio if ct.start_with?('audio/')
    return :video if ct.start_with?('video/')

    :file
  end

  # Nome do arquivo no CRM (o `name` da Graph pode ter nome do paciente: fica só no banco da VPS).
  def nome_do_arquivo(nome, ct, tipo, idx)
    base = File.basename(nome.to_s).gsub(/[^[:alnum:]_. -]/, '_')[0, 100].to_s.strip
    ext = EXTENSOES[ct]
    base = "#{tipo}-#{idx + 1}" if base.empty?
    base += ".#{ext}" if ext && File.extname(base).empty?
    base
  end

  # ─── Fontes (de onde vêm as conversas) ───────────────────────────────────────────────────────────────────────────

  MAX_PAGINAS_DE_MENSAGENS = 200 # 20 mil mensagens numa conversa: acima disso a conversa é marcada como possivelmente truncada

  CAMPOS_MENSAGEM = {
    messenger: 'id,created_time,from,message,attachments,sticker,shares,is_unsupported',
    instagram: 'id,created_time,from,message,attachments,shares,story,reply_to,is_unsupported'
  }.freeze

  # A Meta de verdade. `canal` = :messenger | :instagram. `lado_pagina` = page_id (Messenger) ou instagram_id (Instagram).
  class FonteMeta
    attr_reader :lado_pagina, :graph

    def initialize(canal:, graph:, lado_pagina:)
      @canal = canal
      @graph = graph
      @lado_pagina = lado_pagina.to_s
      @raiz = canal == :messenger ? "/#{@lado_pagina}/conversations" : '/me/conversations'
    end

    def plataforma
      @canal == :messenger ? 'messenger' : 'instagram'
    end

    # Cada conversa: { 'id', 'updated_time', 'participants' => { 'data' => [...] } }  (lista barata; as mensagens vêm uma a uma)
    def conversas(limite: nil)
      n = 0
      @graph.paginar(@raiz, platform: plataforma, limit: 25, fields: 'id,updated_time,participants') do |dados, _|
        dados.each do |c|
          return if limite && n >= limite

          n += 1
          yield c
        end
      end
    end

    # Todas as mensagens da conversa (cruas), da mais nova para a mais velha. [lista, truncada?]
    # No Instagram a Meta só devolve as ~20 mais recentes: se vier 20 ou mais, marca como possivelmente truncada.
    def mensagens(conversa_id)
      limite = @canal == :messenger ? 100 : 20
      r = @graph.get("/#{conversa_id}", fields: "messages.limit(#{limite}){#{CAMPOS_MENSAGEM.fetch(@canal)}}")
      bloco = r['messages'].is_a?(Hash) ? r['messages'] : {}
      todas = (bloco['data'] || []).dup
      # Instagram: a Meta só entrega as 20 mais recentes; a paging.next existe mas devolve «código 4 / subcódigo 1349210» (parece limite de
      # chamadas e não é) — NÃO se segue. No Messenger segue-se até o fim.
      prox = @canal == :messenger ? bloco.dig('paging', 'next') : nil
      paginas = 1
      while prox.to_s != '' && paginas < MAX_PAGINAS_DE_MENSAGENS # as páginas seguintes já vêm como lista {data, paging}
        bloco = @graph.get(prox)
        todas.concat(bloco['data'] || [])
        prox = bloco.dig('paging', 'next')
        paginas += 1
      end
      truncada = @canal == :instagram ? todas.size >= 20 : prox.to_s != '' # Messenger: ainda sobrou página depois do teto
      [todas, truncada]
    end

    # Nome (e @usuário) de UMA pessoa na caixa: Messenger por user_id (PSID); serve à rotina dos «John Doe».
    def participante_por_usuario(user_id)
      r = @graph.get(@raiz, platform: plataforma, user_id: user_id, fields: 'id,participants')
      conv = (r['data'] || []).first
      conv && participante_externo_de(conv)
    end

    def participante_externo_de(conv)
      HistoricoSocial.participante_externo(conv.dig('participants', 'data'), lado_pagina: @lado_pagina)
    end

    # Instagram: perfil de quem escreveu (mesma chamada que o Chatwoot faz ao criar o contato). nil se a Meta negar.
    def perfil_instagram(igsid)
      # perfil negado (230 «consentimento do usuário», 10, 200, 3, 9010, 100…) NÃO para nada: o próprio Chatwoot ignora e segue sem o nome.
      # Só token (190) e limite de chamadas param a rodada.
      r = @graph.get("/#{igsid}", { fields: 'name,username' }, true)
      { 'name' => HistoricoSocial.limpar(r['name']), 'username' => HistoricoSocial.limpar(r['username']) }
    rescue ErroDaMeta
      nil
    end
  end

  # Fonte de mentira para o teste na cópia (fixtures em JSON): mesmo contrato da FonteMeta, sem rede.
  class FonteFixture
    attr_reader :lado_pagina

    def initialize(dados, lado_pagina:)
      @dados = dados
      @lado_pagina = lado_pagina.to_s
    end

    def conversas(limite: nil)
      (@dados['conversas'] || []).each_with_index do |c, i|
        return if limite && i >= limite

        yield c
      end
    end

    def mensagens(conversa_id)
      c = (@dados['conversas'] || []).find { |x| x['id'] == conversa_id }
      lista = c ? (c['messages'] || []) : []
      [lista, lista.size >= 20]
    end

    def participante_por_usuario(user_id)
      c = (@dados['conversas'] || []).find { |x| (x.dig('participants', 'data') || []).any? { |p| p['id'] == user_id } }
      c && participante_externo_de(c)
    end

    def participante_externo_de(conv)
      HistoricoSocial.participante_externo(conv.dig('participants', 'data'), lado_pagina: @lado_pagina)
    end

    def perfil_instagram(igsid)
      (@dados['perfis'] || {})[igsid]
    end
  end
end
