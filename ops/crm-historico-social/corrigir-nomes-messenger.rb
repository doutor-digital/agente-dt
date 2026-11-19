# frozen_string_literal: true

# CORRIGE OS «John Doe» DO MESSENGER (caixa 8). O Chatwoot pede o perfil da pessoa à Meta (get_object do PSID); a Meta nega (falta o
# recurso «Business Asset User Profile Access», que só vem com revisão do app) e o contato nasce «John Doe». O NOME vem de outro lugar,
# que a Meta libera: GET /{page_id}/conversations?platform=messenger&user_id={PSID}&fields=participants.
#
# Roda DENTRO do contêiner chatwoot_rails (rails runner), disparado a cada 10 min pelo cron da VPS (nomes-messenger-cron.sh), que só
# acorda o Rails quando existe «John Doe» novo. Só ids e contagens na saída.
#
# Silêncio: troca o nome com `update_all` (sem callbacks: não há evento contact.updated, webhook, automação nem job), nunca encosta em
# conversa nem em last_activity_at, e o UPDATE leva a condição «nome ainda é John Doe/vazio» no WHERE — se a equipe editou o nome no meio
# do caminho, nada é sobrescrito.
#
#   GRAVAR=1  grava (sem isto: seco, só conta)      CAIXA=8     caixa do Messenger
#   DIAS=3    só contatos criados nos últimos N dias (0 = todos)   HORAS=2  idem em horas (vale no lugar de DIAS)
#   MAXIMO=30 no máximo N consultas à Meta por rodada
#   RITMO=0.7 segundos entre chamadas à Meta
require 'json'
require File.join(ENV['HS_DIR'] || File.dirname(File.expand_path(__FILE__)), 'historico_social')

S = HistoricoSocial unless defined?(S)
$stdout.sync = true

GRAVAR = ENV['GRAVAR'] == '1'
CAIXA = (ENV['CAIXA'] || '8').to_i
DIAS = (ENV['DIAS'] || '3').to_i
HORAS = ENV['HORAS'].to_i
MAXIMO = (ENV['MAXIMO'] || '30').to_i
RITMO = (ENV['RITMO'] || '0.7').to_f

def log(texto)
  puts "LOG #{Time.now.utc.strftime('%Y-%m-%d %H:%M:%S')} nomes-messenger: #{texto}"
end

c = Hash.new(0)
begin
  inbox = Inbox.find(CAIXA)
  raise "a caixa #{CAIXA} não é Messenger" unless inbox.channel_type == 'Channel::FacebookPage'

  escopo = Contact.joins(:contact_inboxes).where(contact_inboxes: { inbox_id: inbox.id })
                  .where(S.sql_nome_padrao('contacts.name'))
  janela = HORAS.positive? ? HORAS * 3600 : DIAS * 86_400
  escopo = escopo.where('contacts.created_at > ?', Time.now.utc - janela) if janela.positive?
  c[:candidatos] = escopo.count
  if c[:candidatos].zero?
    log "GRAVANDO=#{GRAVAR} candidatos=0"
    exit 0
  end

  ch = inbox.channel
  if ENV['FIXTURES'].to_s.empty?
    graph = S::Graph.new(base: 'https://graph.facebook.com/v22.0', token: ch.page_access_token, ritmo: RITMO)
    fonte = S::FonteMeta.new(canal: :messenger, graph: graph, lado_pagina: ch.page_id)
  else # teste: conversas da página num JSON, sem rede
    fonte = S::FonteFixture.new(JSON.parse(File.read(ENV['FIXTURES'])).fetch('messenger'), lado_pagina: ch.page_id)
  end

  escopo.order('contacts.id DESC').limit(MAXIMO).pluck('contacts.id', 'contact_inboxes.source_id').each do |contato_id, psid|
    c[:consultados] += 1
    begin
      externo = fonte.participante_por_usuario(psid)
      nome = externo && externo[0] == psid ? externo[1] : ''
      if nome.empty? || nome == S::NOME_PADRAO
        c[:sem_nome_na_meta] += 1
        next
      end
      c[:nomes_a_corrigir] += 1
      next unless GRAVAR

      if Contact.where(id: contato_id).where(S.sql_nome_padrao('name')).update_all(name: nome).positive?
        c[:corrigidos] += 1
        puts "REG #{{ tipo: 'nomes', caixa: inbox.id, ids: [contato_id] }.to_json}"
      else
        c[:editado_no_meio] += 1 # a equipe mexeu no nome entre a leitura e a gravação: nada sobrescrito
      end
    rescue S::ErroDaMeta => e
      c[:erros_da_meta] += 1
      log "erro da Meta em um contato (#{e.message})"
    end
  end
  log "GRAVANDO=#{GRAVAR} " + c.sort_by { |k, _| k.to_s }.map { |k, v| "#{k}=#{v}" }.join(' ')
rescue S::Parar => e
  log "PAREI: #{e.message} " + c.map { |k, v| "#{k}=#{v}" }.join(' ')
  exit 2
rescue StandardError => e
  log "ERRO (#{e.class.name})"
  exit 1
end
