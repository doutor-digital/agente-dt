import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chamadoDaFranquia, nomeDaUnidadeNoChamado, SISTEMA_DE_DESTINO, URL_DA_FRANQUEADORA } from './chamado-franqueadora.js';
import { validarFormulario } from './formulario.js';
import { respostasValidas } from './formulario-exemplo.js';

const respostas = (mudar: (r: ReturnType<typeof respostasValidas>) => void = () => {}) => {
  const r = respostasValidas();
  mudar(r);
  const v = validarFormulario(r);
  assert.ok(v.ok, JSON.stringify(v));
  return v.ok ? v.respostas : (undefined as never);
};

test('o nome da unidade não repete «Doutor Hérnia»: «Doutor Hérnia Serra» → «Serra»; sem o prefixo, fica inteiro', () => {
  assert.equal(nomeDaUnidadeNoChamado('Doutor Hérnia Serra'), 'Serra');
  assert.equal(nomeDaUnidadeNoChamado('doutor hernia - São José'), 'São José');
  assert.equal(nomeDaUnidadeNoChamado('Dr. Hérnia Porto Velho'), 'Porto Velho');
  assert.equal(nomeDaUnidadeNoChamado('Clínica Dra. Ana'), 'Clínica Dra. Ana');
  assert.equal(nomeDaUnidadeNoChamado('Doutor Hérnia'), 'Doutor Hérnia', 'nada sobra: não vira vazio');
});

test('título e texto: a redação do João com os dados do formulário nos lugares dele, e «CRM da Doutor Digital» (um parâmetro só) nos dois pontos', () => {
  const c = chamadoDaFranquia(respostas());
  assert.equal(c.url, 'https://app.doutorhernia.com.br/login');
  assert.equal(URL_DA_FRANQUEADORA, c.url);
  assert.equal(c.titulo, 'Solicitação de Token de Integração – Doutor Hérnia Serra');
  const t = c.texto;
  assert.match(t, /^Bom dia, equipe\.\n\nSolicito a liberação do Token de Integração para esta unidade, conforme as informações técnicas abaixo:\n\nResponsável: Dra\. Ana Teste\nE-mail: ana\.teste@clinica\.example\n/);
  assert.match(t, /Ferramenta que realizará a integração: Doutor Digital\nSistema de destino: CRM da Doutor Digital\nEmpresa responsável pela integração: Doutor Digital\nUnidade a ser integrada: Doutor Hérnia – Serra\nDados que serão consumidos via API:/);
  assert.match(t, /Agenda de pacientes;\nCadastro de leads e pacientes;\nGrade de horários disponíveis;\nStatus das consultas, incluindo confirmações, remarcações e cancelamentos;\nCategorias de atendimento\.\nTratamentos\nTudo relacionado a api da franquia\./);
  assert.match(t, /Objetivo da integração: Realizar a integração da agenda da unidade ao CRM da Doutor Digital, possibilitando/);
  assert.equal((t.match(/CRM da Doutor Digital/g) ?? []).length, 2);
  assert.doesNotMatch(t, /Kommo/);
  assert.match(t, /Atenciosamente,\n\nDra\. Ana Teste Franqueado\(a\) – Doutor Hérnia$/);
  assert.equal(SISTEMA_DE_DESTINO, 'CRM da Doutor Digital');
  assert.doesNotMatch(t, /Franqueada\b/, 'não supõe gênero');
});

test('linha extra: pede o código da unidade (id_company) só se o formulário não trouxe, e sempre o idStaff de cada profissional', () => {
  const sem = chamadoDaFranquia(respostas()).texto;
  assert.match(sem, /Peço também informar o código da unidade na franquia \(id_company\) e o código de cada profissional \(idStaff\): Dra\. Ana Teste\.\n\nAtenciosamente/);
  const com = chamadoDaFranquia(respostas((r) => { r.franquia_id_company = '131'; r.profissionais.push({ nome: 'Dr. Beto Souza', funcao: 'medico' }); })).texto;
  assert.match(com, /Peço também informar o código de cada profissional \(idStaff\): Dra\. Ana Teste; Dr\. Beto Souza\.\n\nAtenciosamente/);
  assert.doesNotMatch(com, /id_company/);
});

test('nada sensível: nem o link/código do formulário, nem e-mail de atendente, Pix, telefone, chave ou valor', () => {
  const c = chamadoDaFranquia(respostas());
  const tudo = `${c.titulo}\n${c.texto}`;
  for (const pii of ['gerente@clinica.example', 'recepcao@clinica.example', 'celular@clinica.example', 'pix-teste', 'Clínica Teste Ltda', '99999', '3333-4444', '+55', 'nova-clinica', 'agente-vps', '350', '250']) assert.ok(!tudo.includes(pii), `vazou: ${pii}`);
  // o único e-mail é o do próprio responsável (campo «E-mail» do texto padrão)
  assert.deepEqual(tudo.match(/[\w.+-]+@[\w.-]+/g), ['ana.teste@clinica.example']);
});
