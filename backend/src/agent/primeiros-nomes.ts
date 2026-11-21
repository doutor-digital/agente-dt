/**
 * Primeiros nomes comuns no Brasil (sem acento, minúsculos) — a prova de que uma palavra solta, dita depois de "como posso te chamar?",
 * é mesmo um nome: a PRIMEIRA palavra da resposta tem que estar aqui (ver `nomeCorroborado` em name-capture.ts).
 *
 * Por que existe: sem isso a rede de segurança do título gravava no cartão qualquer palavra que o paciente escrevesse logo depois da
 * pergunta do nome — "Lomba", "Esim", "Canaense", "Nego lindo", "Aonde faca" (medido 05–21/11/2026, rede toda). Nome brasileiro não
 * tem forma que a distinga de palavra comum; só uma lista distingue. (O nome do contato/perfil não serve: quem o grava é a própria IA.)
 *
 * Fica de fora de propósito:
 *  - palavra que também é palavra comum, cidade ou sobrenome: "rosa", "luz", "paz", "gloria", "bento", "leia", "nova", "lindo", "jesus",
 *    "socorro", "salvador", "marco", "nazare", "tais", "tomas", "irma" (irmã), "clara", "aurora", "domingos";
 *  - os nomes das IAs da rede — "aline" (Salto), "sara" e "cintia" (Tatuí), "sophia"/"sofia": «Aline, boa tarde…» no áudio é o paciente
 *    falando com a atendente, não o nome dele.
 *
 * Lista curta e conservadora: nome que falta aqui só deixa o título para a IA (atualizar_titulo_lead) um turno depois; nome que sobra
 * aqui é nome gravado errado. Pode crescer, nunca com palavra do dicionário.
 */
const LISTA = `
abel abelardo abigail abmael abraao adalberto adalto adao adeilma adeilson adelaide adelita adelmo adelson ademar ademilson ademir adenilson
adenis adilma adilson adimir adna adnaldo adriana adriane adriano adriele adrielly adriely aecio afonso agatha agnalda agnaldo agostinho
aguinaldo ailton airton alaide alaides alan alana alba albano albertina alberto alcides alcino alcione alcivan alda aldair aldedina aldemir
aldenes aldenir aldenor aldineia aldo aleciane alessa alessandra alessandro alex alexandra alexandre alexia alexsandra alexsandro alfredo
alice alicia alisson allan alvaro alyne alzenir alziane alzira amabel amadeu amanda amaro ambrosio amelia amilton ana anacleto anaide analia
analice anastacia anderson andre andrea andrei andreia andressa andreza andriele angela angelica angelina angelita anisia anita anna anselmo
antenor anthony antonia antonieta antonio aparecida aparecido araci arcanjo areta ariana ariane arilson aristeu arleandro arleilson arlete
arlindo armando armindo arnaldo arnoldo arquides arthur artur atila augusto aurea aurelina aurelio auricelia avelino ayla ayrton baltazar
barbara bartira bartolomeu beatriz benedita benedito benjamin berenice bernadete bernardo betania bete beth betina bia bianca brenda brenno
breno bruna brunna bruno bryan cacilda caetano caio calebe camila camilla camilo candida carina carla carlijane carline carlos carlota
carmelita carmem carmen carolaine carolina caroline cassia cassio catarina catia cecilia celi celia celiane celina celio celma celso cesar
cesario charlene charles chayane chayla cheila christian cibele cicera cicero cida cinara cinthia cinthya cirlene clarice clark claudemir
claudete claudhonson claudia claudiane claudinei claudineia claudio claudionor cleber clebson cleci clecio cleia cleide cleilson cleiton
cleiziane cleomar cleonice cleudiane cleudivanes cleusa cleuza climis clodoaldo clotilde clovis conceicao conrado constancia cosme cosmo
creuza crisania crislaine crislayne cristian cristiane cristiano cristiele cristina cristovao dagmar daiana daiane dalila dalva dalvan
dalvinha damares damiao dan dandara dania daniel daniela daniele danilo darci dario darlene davi david davison dayana dayane dayse debora
deborah delizete delma delmires denice denilson denilton denis denise denisete dennis deusdete deusenir dhermy diana diego dieison dilma
dimilto dinorah diogo dione dionisio diorgenes dirce domingas dora doralice dorival dorothy douglas driele duda dulce dyonailton edcarlos
eder edevaldo edgar edgard ediane edicassio edilberto edilene edilson edilva edimar edina edinaldo edinei edineia edipo edite edith edivaldo
edjane edmar edmilson edna ednaldo ednalva edneia edonaldo edson eduarda eduardo eduina edvaldo edvan edvania edwiges elaide elaine elane
elda elen eleni elenice elenir eleonora elexsandra eli eliakim eliana eliandro eliane elias elida elielson eliene eliet eliete eliette
eliezer elinete eliomar elionai elionora elisa elisabete elisabeth elisangela elisete eliseu elismar elisvanda eliude elivanda elizabete
elizabeth elizandra elizangela elizete elizeth elizethe elizonar elke ellinton elmo eloisa eloiza elton elza elzira emanoela emanuel
emanuella emanuelle emerson emilia emilly emily emmanuel enos enzo erasmo erenilton eriberto erica erick erico erika erinalda erinalva
erivaldo erivanilson erlandia ernande ernandes ernesto eronilton eronita esdras estefani estefania estela estelita esther etelvina eucilene
eudes eudilene eudimar eudo eugenia eugenio eulalia eulinda eunice euripedes euza eva evaldo evando evandro evangelista evanir evelin
evelina evelyn everton expedito ezequias ezequiel fabia fabiana fabiane fabiano fabio fabiola fabricia fabricio fagner fatima fausto felicia
felicio felipe ferdinan fernanda fernando filipe filomena fioravante flavia flavio florencia florentina florinda franciane franciele
francieli francileia francilene francineide francinete francisca francisco francivaldo francy frank franki franklin frederico gabriel
gabriela gabriele gabrieli gabrielle geane gecira gedalva gedeao geiciane geisa geise geiza genassi genesis geni genilda geovana geovane
geovani geraldina geraldo gerlan gerlane gerson gesiane gesmar gesner gessica gianna gil gilberto gildean gildemar gildete gildevan gilenio
gilmar gilmara gilson gilvan gilvanete gilvania giovana giovanna girlene gisela gisele giselle gislaine gislene givanildo glaucia gleice
gleiciane gleison gleiza glenda gleycy glorinha goncalo gorete goretti graciele gracielle graziela graziele gregorio greice greicy greizer
guido guilherme gumercindo gustavo hamilton heitor helaine helber helder helena heliete helio hellen heloisa heloise heloiza helton henri
henrique herica hermano hermenegildo hermes hernandes heshylla higor hilda hildevando hiran histael honorato hozimaria hudson hugo huguini
iago ian ianca iara idalina ieda ielane igor ihasmym ilda ilka ilma ilmar ilza inacio ines ingracio ingrid ingridi ingryd iolanda ione
iracema iraci iraene irany irene irenilde irineu iris irislene isa isabel isabela isabele isabella isabelle isabelli isadora isaias isaque
isis ismael ismar israel italo itamar iva ivan ivaneide ivanete ivani ivanice ivanil ivanilda ivanilde ivanilton ivete ivo ivone ivonete
ivonilde izabel izabela izabelle izaias izaque izequiel izildinha jaci jaciara jacinta jacinto jacira jackeline jackson jaco jacqueline
jadir jailda jailson jailton jaime jair jairo jakelin jakson jamile janaina jandira jane janete janice janilson janio janir jaqueline jarbas
jardel jardson jarlan javier jean jeane jeanete jeferson jefferson jenifer jeniffer jennifer jeronimo jessica jhon jhonata jhonatan joana
joanna joao joaquim joaquin joaquina joas jocelia joceline jocinete joda joedson joel joelma joelson johny jonas jonatan jonatas jonathan
joni jordana jordania jorge jorgina josadarc josael josair jose joseane josefa josefina joseilda joselia joselito josemar josiane josias
josielle josielma josilda josimar josinaldo josineide josirene jossane josue josy joyce juan juarez jucelen jucelio jucileia jucilene
jucimara judite julia juliana juliane juliano julieta juliete julio junior juraci jurandir jurema juscelino jussara jussier justina juvenal
kaic kaick kaio kalliny kamila kamilla karen karina karine karla karoliny kassia katia katiane katiany kauan kauany kaue kayque keila kelen
keli kelle kelly kemilly kenia kesia kesya kethelen ketlen kettelyn kevin kleber kleyton ladenilson laerte laila lais lara larissa lauany
laura laurentina lauriana lauro lavinia layla lazaro leandra leandro leda leiciane leide leidiane leidinaura leila lena lene lenilda
lenilson lenita leny leonardo leonice leonilson leonor leopoldo leticia leudimar lia lidia lidiane ligia lilian liliana liliane lindalva
lindomar lineu lioilda lisandra liscibene lisoneide livia liviane liz loanda lorane lorena loreni lorival lorraine lorraynne louis lourdes
lourdiene lourenco lourival loyana luana lucas lucelena lucemar lucenir luceny luci lucia luciana luciane luciano lucielma luciene luciete
lucilei lucileide lucilene lucileuda lucimar lucimara lucimeire lucineide lucivane ludmila luis luisa luiz luiza luizete lurdes luthieina
luzeni luzia luziane luzineide luzinete luzmelis macario macartney magali magda magno maiara maicon mailson mairon maiza manoel manoela
manuel manuela maozinha mara marc marcal marcela marcello marcelo marcia marcilene marcio marciria marcondes marcos marcus margarete
margareth margarethe margarida margrid mari maria mariana mariano maricleide marieli marieta marilda marileide marilene marilia marilucia
marilze marina marineide marinete mario marisa marise marisete maristela marizelha marlene marli marlise marlon marluce marlucia marlucio
marlusa marly marta martinho mary maryane mateus matheus maura mauricio mauro max maximiano maximino mayanne mayara mayko maykon mayra meire
meirelle meiridiana melcidec melissa mercia merlyn messias micaela michael michel michela michele michelle mickhaella miguel mikael mikaela
mikarla milckelany milena milene milton mirela mirella miriam mirian mirla misilael mismara moises monica monique murilo mylena myriam nadia
nadiara nagila naiane naiara nair nana nancy nando nara natalia nataly natan natana natanael nathalia naurilene nayane nayara nayra nazare
neci neide neilma neiva nelma nelson nelsynho nena neno neomar neusa neuton neuza neyara neycursino nicelia nico nicolas nicole nilce nilda
nildete nilsa nilson nilton nilvana nilza nina nivaldo nizia noedes noemi noemia oclecio odair odete odilia odilon olga olimpio olindomar
olivia omar onilia orlando osvaldo osvan oswaldo otacilio otavio otoni otto oziel ozinaldo pablo paloma pamela patriane patricia paula
paulina paulo pedro peterson poliana pollyana pollyanna pricila priscila priscilla queila queli quiteria rafael rafaela rafhaela railma
railson raimar raimunda raimundo rainei rairon raissa ranielle raphael raquel raul rayane raylan rayza rebeca regiane regina reginaldo reina
rejane relbert renan renata renatinho renato rene renilson rey ricardo rildermarques rita rivaldo roberta roberto robson rochelia roderto
rodolfo rodrigo rogerio roland romario romilda romildo romulo ronaldo ronan rosana rosane rosangela rosaria rose roselaine roseli rosely
rosemary rosemeire rosenilda rosi rosiane rosicleia rosicleide rosilene rosimar rosimary rosimeire rosirene rosiris rosivaldo rossany rozana
rozane ruan rubens ruberval rubia rudilene rui ruth ryan sabrina sairto salete salomao samara samela samira samuel sando sandra sandreane
sandro sandy sanny sarajane saulo scheila searusi sebastiana sebastiao selene selima selma serafim sergio severino sheila shelly shirley
sidnei sidney silas silismar silmara silvana silvania silvano silvia silvio simao simone sirlei sirlene solange solimar sonia sophie stefane
stefany stela stelamari stephanie sueila suelen sueli suellen suely susana suzana suzane sylvain sylvia tainara tairani taisa talita tamires
tamiris tamirys tania tarcisio tatiana tatiane telma teresa teresinha tereza terezinha thaina thais thales thalisson thalita thalya thalys
thamires thayane thayani thayna theila thiago tiago tiana tilene timoteo toninha ubirata ubiratan uilson umberto ursula valdeci valdeir
valdemar valderci valderlan valdete valdinei valdir valdirene valdirez valdise valeria valeska valmir valquiria vanda vanderlei vanderleia
vanderli vanessa vanete vania vanicleice vanilda vanilza vanusa vera veronica vicencia vicente vicinaldo victor vilazio vilma vilmar vilmara
vilson vinicius vitor viviana viviane wagner waldeir waldemar waldenis waldines waldir waleska wallisson walter wanda wanderlene wanderley
wanderson wannya warley warlley weber welington welison weliton wellington welmo welson welyda wendel wendson werick wesley whylsa wiliames
wilian wilk william willian wilma wilmar wilson yara yasmin yelimar ygor yoriko yunieski yuri zaira zegilania zelia zenaide zenilda zilda
zildete zilma zuila zuleide zulmira
`;

export const PRIMEIROS_NOMES: ReadonlySet<string> = new Set(LISTA.split(/\s+/).filter(Boolean));
