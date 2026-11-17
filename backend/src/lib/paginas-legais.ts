/**
 * Termos de Uso e Política de Privacidade do «Doutor Digital Atende» (o CRM da Doutor Digital), pedido do João em 14/11/2026:
 * "vamos criar no servidor" — o Chatwoot apontava os links de Termos/Privacidade para o site do Chatwoot.
 * Servidas em /termos e /privacidade; o Chatwoot aponta para cá (TERMS_URL / PRIVACY_URL). Versão inicial: revisar com o jurídico.
 */
const VERSAO = '14 de novembro de 2026';

function pagina(titulo: string, corpo: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} · Doutor Digital Atende</title>
<link rel="icon" href="https://atendimento.doutordigitalconsultoria.com/favicon-32x32.png">
<style>
:root{color-scheme:light}
body{margin:0;background:#f7f8fa;color:#1c2024;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
header{display:flex;align-items:center;gap:12px;margin-bottom:24px}
header img{width:40px;height:40px}
header b{font-size:17px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}
.v{color:#60646c;font-size:13px;margin:0 0 28px}
h2{font-size:17px;margin:28px 0 8px}
p,li{color:#2b2f36}
ul{padding-left:20px}
a{color:#0086f7}
footer{margin-top:40px;padding-top:16px;border-top:1px solid #e8e8ec;color:#60646c;font-size:13px}
</style></head><body><main>
<header><img src="https://agente.doutordigitalconsultoria.com/logo-dd.png" alt=""><b>Doutor Digital Atende</b></header>
<h1>${titulo}</h1><p class="v">Versão de ${VERSAO}</p>
${corpo}
<footer>Doutor Digital · <a href="/termos">Termos de Uso</a> · <a href="/privacidade">Política de Privacidade</a></footer>
</main></body></html>`;
}

export const PAGINA_TERMOS = pagina(
  'Termos de Uso',
  `<p>Estes Termos regem o uso do <b>Doutor Digital Atende</b>, o sistema de atendimento e CRM oferecido pela <b>Doutor Digital</b> às clínicas e empresas clientes (as «Contratantes») e às pessoas que elas autorizam a usá-lo (os «Usuários»).</p>
<h2>1. O que é o serviço</h2>
<p>Uma plataforma para centralizar conversas de WhatsApp e outros canais, organizar contatos e etapas de atendimento (funil), registrar agendamentos e acompanhar resultados. Inclui uma assistente virtual com inteligência artificial que pode responder pacientes e executar tarefas (como consultar horários e registrar agendamentos) conforme a configuração de cada Contratante.</p>
<h2>2. Acesso</h2>
<ul><li>O acesso é pessoal, por login e senha. O Usuário é responsável por manter a senha em sigilo e por tudo o que for feito com o seu acesso.</li>
<li>Cada Contratante enxerga apenas os dados da própria conta.</li>
<li>A Doutor Digital pode suspender acessos usados de forma irregular ou que coloquem em risco a segurança do serviço.</li></ul>
<h2>3. Uso permitido</h2>
<ul><li>Usar o serviço apenas para o atendimento legítimo dos clientes e pacientes da Contratante.</li>
<li>Respeitar as regras do WhatsApp e da Meta, incluindo as de envio de mensagens e de modelos aprovados.</li>
<li>Não enviar conteúdo ilegal, enganoso, ofensivo ou mensagens em massa sem consentimento.</li>
<li>Não tentar acessar dados de outras contas nem burlar os controles de segurança.</li></ul>
<h2>4. Assistente virtual (IA)</h2>
<p>As respostas da assistente são geradas automaticamente e podem conter erros. A Contratante define o que ela pode fazer, pode pausá-la a qualquer momento e é responsável por revisar informações sensíveis, como valores, orientações clínicas e confirmações de agendamento. A assistente não faz diagnóstico nem substitui o atendimento de um profissional de saúde.</p>
<h2>5. Dados</h2>
<p>Os dados de pacientes e clientes cadastrados no serviço pertencem à Contratante. A Doutor Digital trata esses dados apenas para prestar o serviço, conforme a <a href="/privacidade">Política de Privacidade</a> e a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).</p>
<h2>6. Disponibilidade</h2>
<p>Buscamos manter o serviço disponível e com cópias de segurança, mas ele pode ter interrupções por manutenção, falhas de terceiros (como a Meta e o WhatsApp) ou fatores fora do nosso controle.</p>
<h2>7. Responsabilidades</h2>
<p>A Doutor Digital não responde por decisões tomadas pela Contratante com base nas informações do sistema, por conteúdos enviados pelos Usuários, nem por indisponibilidades de serviços de terceiros. A Contratante responde pelo uso que seus Usuários fazem do serviço.</p>
<h2>8. Alterações</h2>
<p>Estes Termos podem ser atualizados. A versão em vigor é sempre a publicada nesta página, com a data no topo.</p>
<h2>9. Contato</h2>
<p>Dúvidas sobre estes Termos: pelo canal de suporte da Doutor Digital informado à sua clínica.</p>`,
);

export const PAGINA_PRIVACIDADE = pagina(
  'Política de Privacidade',
  `<p>Esta Política explica como o <b>Doutor Digital Atende</b> trata dados pessoais, em conformidade com a Lei Geral de Proteção de Dados (LGPD, Lei nº 13.709/2018).</p>
<h2>1. Quem é quem</h2>
<p>A clínica ou empresa que contrata o serviço é a <b>controladora</b> dos dados dos seus pacientes e clientes: é ela quem decide para que os dados são usados. A <b>Doutor Digital</b> atua como <b>operadora</b>: trata os dados em nome da Contratante, apenas para prestar o serviço.</p>
<h2>2. Quais dados</h2>
<ul><li><b>De pacientes e clientes:</b> nome, telefone, mensagens trocadas (texto, áudios, imagens e documentos), dados de agendamento e de atendimento, etapa no funil e, quando a pessoa chega por anúncio, a identificação do anúncio.</li>
<li><b>Dos Usuários (equipe da clínica):</b> nome, e-mail, registros de acesso e as ações feitas no sistema.</li></ul>
<h2>3. Para que usamos</h2>
<ul><li>Receber, organizar e responder as conversas da Contratante.</li>
<li>Permitir que a assistente virtual responda, consulte horários e registre agendamentos, quando a Contratante ativar.</li>
<li>Transcrever áudios enviados pelos pacientes, para facilitar o atendimento.</li>
<li>Gerar relatórios de atendimento e de resultados de campanhas para a Contratante, inclusive o envio de eventos de conversão à Meta quando a Contratante ativar essa função.</li>
<li>Manter a segurança, cópias de segurança e o funcionamento do serviço.</li></ul>
<p>Não vendemos dados pessoais e não os usamos para fins próprios fora do serviço.</p>
<h2>4. Com quem compartilhamos</h2>
<p>Somente com fornecedores necessários para o serviço funcionar, que tratam os dados conforme as nossas instruções:</p>
<ul><li>Meta e provedores de integração com o WhatsApp, para enviar e receber mensagens;</li>
<li>provedores de inteligência artificial, para a assistente virtual e a transcrição de áudios;</li>
<li>provedores de servidor e de armazenamento, para hospedar o sistema e guardar as cópias de segurança (cifradas).</li></ul>
<p>Também podemos compartilhar dados quando a lei ou uma ordem de autoridade competente exigir.</p>
<h2>5. Por quanto tempo</h2>
<p>Enquanto durar o contrato com a Contratante e pelo prazo que ela definir ou que a lei exigir. Ao fim do contrato, os dados podem ser devolvidos à Contratante e depois excluídos, salvo obrigação legal de guarda.</p>
<h2>6. Segurança</h2>
<p>Acesso por login individual, separação entre as contas das Contratantes, conexões cifradas (HTTPS), cópias de segurança cifradas e registro de ações. Nenhum sistema é totalmente imune a incidentes; se ocorrer um incidente relevante, a Contratante será avisada.</p>
<h2>7. Direitos dos titulares</h2>
<p>Pacientes e clientes podem pedir acesso, correção, anonimização, portabilidade ou exclusão dos seus dados, e informações sobre o compartilhamento. Esses pedidos devem ser feitos à clínica ou empresa com quem a pessoa se relaciona (a controladora); a Doutor Digital apoia a Contratante no atendimento a eles.</p>
<h2>8. Cookies</h2>
<p>O sistema usa apenas os cookies necessários para manter o Usuário conectado e o funcionamento das telas.</p>
<h2>9. Alterações e contato</h2>
<p>Esta Política pode ser atualizada; a versão em vigor é a publicada nesta página. Dúvidas: pelo canal de suporte da Doutor Digital informado à sua clínica, ou diretamente com a clínica responsável pelo seu atendimento.</p>`,
);
