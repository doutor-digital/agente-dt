/**
 * Primeiros nomes comuns no Brasil (sem acento, minúsculos) — a prova de que uma palavra solta, dita depois de "como posso te chamar?",
 * é mesmo um nome. Fora desta lista a palavra só vale se aparecer no perfil do WhatsApp do contato (ver name-capture.ts).
 *
 * Por que existe: sem isso a rede de segurança do título gravava no cartão qualquer palavra que o paciente digitasse logo depois da
 * pergunta do nome — "Lomba", "Esim", "Canaense", "Nego lindo", "Aonde faca" (medido 05–21/11/2026, rede toda). Nome brasileiro não
 * tem forma que a distinga de palavra comum; só uma lista ou o perfil distinguem.
 *
 * Fica de fora de propósito: palavra que também é palavra comum ("rosa", "luz", "paz", "gloria", "bento", "leia", "nova", "lindo",
 * "jesus", "socorro", "salvador", "marco", "nazare", "tais"), porque "Rosa" digitado sozinho pode ser cor, e "Leia" pode ser o verbo. Quem tiver esse nome passa pelo perfil do WhatsApp
 * ou por «meu nome é…».
 *
 * Lista curta e conservadora: nome que falta aqui só deixa o título para a IA (atualizar_titulo_lead) um turno depois; nome que sobra
 * aqui é nome gravado errado. Pode crescer, nunca com palavra do dicionário.
 */
const LISTA = `
abel abelardo abigail abraao adalberto adao ademar ademir adenilson adilson adriana adriane adriano adriele adrielly aecio afonso agatha
agnaldo agostinho aguinaldo ailton airton alaide alan alana alba albano albertina alberto alcides alcione alda aldair aldemir aldo alessandra
alessandro alex alexandra alexandre alexia alice aline alisson allan alvaro alyne amanda amaro amelia amilton ana anacleto anderson andre
andrea andreia andreza andrei angela angelica angelina angelita anisia anita anna antonia antonieta antonio aparecida arlete arlindo armando
arnaldo arthur augusto aurea aurelio aurora ayrton barbara bartolomeu beatriz benedita benedito benjamin bernardo berenice bete betania bianca
brenda brenno breno bruna bruno bryan caio camila camilo candida carla carlos carlota carmem carmen carmelita carolina caroline cassia cassio catarina catia
cecilia celia celina celio celso cesar chayane cicera cicero cida cinara cintia clara clarice claudemir claudete claudia claudio claudinei clebson
cleber cleide cleiton cleonice cleusa clovis conceicao constancia cosme cristiane cristiano cristina cristovao dagmar daiana daiane dayane dayana dalila
dalva damiao daniel daniela danilo darci davi david deborah debora denilson denis denise denice deusdete diana diego dilma dinorah diogo dione
dirce domingos dora doralice dorival douglas edcarlos edgar edilson edimar edinaldo edinei ediane edite edna edson eduarda eduardo edvaldo edwiges elaine
elda eleonora eli elias eliana elias elida eliene eliete elisa elisangela elisete elizabete elizabeth elizeth elton elza emanuel emerson emilia emily
enzo erica erick erika ernesto estela estelita esther eugenia eunice eva evandro evelyn evelin everton ezequiel fabiana fabiano fabio fabia
fabricia fabricio fatima felipe felicia fernanda fernando filipe flavia flavio florencia florinda francieli franciele francineide francinete
francisca francisco frederico gabriel gabriela gabrielle gabrieli geisa geise genilda geraldo gerson gessica gilberto gildete gilmar gilmara gilson
gilvan giovana giovanna gisele giselle gislaine givanildo gleice gleiciane gleison graciele gregorio guilherme gustavo heitor helena
helio heloisa heloise henrique hermes hilda hugo iara ian ianca idalina ilma ilda ilza ines ingrid ingryd irene irineu iris irma isa isabel
isabela isabele isabella isabelle isadora isaias isaque isis ismael israel italo itamar iva ivan ivanete ivani ivanilda ivone ivonete izabel izabela
izabelle izildinha jacinta jaciara jacqueline jadir jaime jair jairo jandira janaina jane janete janice janilson jaqueline jean jefferson jeferson jenifer
jessica joana joao joaquim joaquina jocelia joel joelma jonas jonatas jonathan jordana jorge jose josefa josefina joseane joselia joselito josemar josiane
josias josielle josimar josineide josue joyce juan judite julia juliana julio julieta junior jurema jussara justina kaio karen karina karine karla
kassia katia kauan kauany kaue kayque keila kelly kelen kenia ketlen kevin laerte laila laura lauro lavinia layla leandro leda leila leonardo
leonor leopoldo leticia lidia lidiane ligia lilian liliane lindalva lindomar lineu lisandra livia liz loreni lorena lorraine lorane lourdes
lourival lourenco luana lucas luci lucia luciana luciane luciano lucimar lucimara luciene lucilene lucileide ludmila luis luisa luiz luiza lurdes
magda magno mailson maiara maicon mairon manoel manuel manuela mara marcela marcelo marcia marcio  marcos margarete margarida maria mariana
mariano maricleide marilene marilia marilda marina mario marisa marise marisete maristela marlene marli marlene marlise marlon marta mateus matheus
mauricio mauro maximiano mayara mayra meire melissa mercia michele michelle miguel milena miriam mirian mirela moises monica monique murilo nadia
nair nancy naiara natalia natan natanael nathalia nayara nayane  neide nelma nelson neuza neusa nicolas nicole nilce nilda nilson nilsa nilza
nivaldo noemia noemi odete olga olimpio olivia omar orlando osvaldo oswaldo otavio otacilio paloma pamela patricia paula paulina paulo pedro
poliana priscila priscilla rafael rafaela rafhaela raimunda raimundo raquel raul rayane rebeca regiane regina reginaldo renan renata renato rene
ricardo rita roberta roberto robson rodolfo rodrigo rogerio romario romulo ronaldo ronan rosana rosangela  rosaria rosane roseli
rosemeire rosemary rosenilda rosilene rosimeire rozana rozane ruan rubens rubia rui ruth sabrina  samara samuel sandra sandro sandy sara
sarah saulo sebastiao selma selene serafim sergio severino sheila shirley sidney sidnei silmara silvana silvano silvia silvio simone simao sirlene
 solange sonia sophia sophie stefany stephanie sueli suelen suellen sueli susana suzana suzane  talita tainara tamires tania tatiana
tatiane tereza terezinha teresa teresinha thais thaina thales thalisson thalita thiago thais tiago tiana  ubiratan ursula valdemar valdir valdeci
valeria valmir vanderlei vanessa vania vera veronica vicente victor vitor vinicius viviane viviana wagner waldemar waldir waldines waleska walter
wanda wanderlene wanderley wellington welington welison wendel wesley wilian willian wilma wilmar wilson yasmin yara yuri zaira zelia zenaide zilda
zildete zilma zuleide zulmira
`;

export const PRIMEIROS_NOMES: ReadonlySet<string> = new Set(LISTA.split(/\s+/).filter(Boolean));
