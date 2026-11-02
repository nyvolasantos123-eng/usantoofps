// Windows batch files use ASCII. Registry Editor expects UTF-16LE with a BOM.
export function encodeFile(name, content) {
  const text = content.replace(/\r?\n/g, '\r\n');
  if (!name.endsWith('.reg')) return new TextEncoder().encode(name.endsWith('.txt') ? '\uFEFF' + text : text);
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, true);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  return bytes;
}

function panel(title, command, success, help) {
  return `@echo off
setlocal EnableExtensions DisableDelayedExpansion
title usantoosfps - ${title}
echo ${title}
echo.
${command}
if errorlevel 1 goto falha
echo ${success}
pause
exit /b 0
:falha
echo ${help}
pause
exit /b 1
`;
}

function powershell(script) {
  // Fixed source only. Pass filesystem paths through environment variables.
  const source = script.trim().replace(/\s*\n\s*/g,' ');
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { ${source} } catch { Write-Host $_.Exception.Message; exit 1 }"`;
}

const visualKeys = [
  ['Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', 'EnableTransparency', 'DWord', 0],
  ['Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', 'TaskbarAnimations', 'DWord', 0],
  ['Control Panel\\Desktop', 'MenuShowDelay', 'String', '100'],
];

function regFile(keys) {
  const entries = keys.map(([path,name,type,value]) =>
    `[HKEY_CURRENT_USER\\${path}]\n"${name}"=${type === 'DWord' ? 'dword:' + value.toString(16).padStart(8,'0') : '"' + value + '"'}`);
  return 'Windows Registry Editor Version 5.00\n\n' + entries.join('\n\n') + '\n';
}

// Keep each user's original values, including values that did not exist.
const backupDir = String.raw`$dir=Join-Path $env:LOCALAPPDATA ('usantoosfps\RaioX\'+$env:COMPUTERNAME); [void][IO.Directory]::CreateDirectory($dir);`;
const backupVisual = powershell(`${backupDir}
  $file=Join-Path $dir 'Visuais_originais.reg';
  if(Test-Path -LiteralPath $file){Write-Host 'Copia anterior preservada:' $file; exit 0};
  $lines=@('Windows Registry Editor Version 5.00','');
  foreach($row in @(${visualKeys.map(([path,name])=>`@('${path}','${name}')`).join(',')})){
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($row[0]);
    $v='-';
    if($key -and $key.GetValueNames() -contains $row[1]){
      $kind=$key.GetValueKind($row[1]); $value=$key.GetValue($row[1]);
      if($kind -eq 'DWord'){$v='dword:'+('{0:x8}' -f $value)}
      elseif($kind -eq 'String' -and $value -match '^[0-9]+$'){$v=[char]34+[string]$value+[char]34}
      else{throw 'Valor fora do formato esperado. Mantenha os ajustes atuais.'}
    };
    if($key){$key.Close()};
    $lines+=('[HKEY_CURRENT_USER\\'+$row[0]+']'),(([string][char]34)+$row[1]+[char]34+'='+$v),''
  };
  $tmp=Join-Path $dir ([guid]::NewGuid().ToString()+'.tmp');
  try{[IO.File]::WriteAllLines($tmp,[string[]]$lines,[Text.Encoding]::Unicode); [IO.File]::Move($tmp,$file)}finally{if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}};
  Write-Host 'Copia salva em' $file;`);

const restoreVisual = powershell(`${backupDir}
  $file=Join-Path $dir 'Visuais_originais.reg';
  if(!(Test-Path -LiteralPath $file)){throw 'Backup nao encontrado para este usuario e PC.'};
  reg.exe import $file; if($LASTEXITCODE -ne 0){throw 'O Registro recusou a importacao.'};`);

const report = powershell(`
  $os=Get-CimInstance Win32_OperatingSystem;
  $cpu=(Get-CimInstance Win32_Processor).Name -join ', ';
  $gpu=Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion;
  $plan=powercfg.exe /getactivescheme; if($LASTEXITCODE){throw 'Falha ao consultar energia.'};
  $file=Join-Path $env:RAIOX_DIR ('Relatorio_'+(Get-Date -Format 'yyyyMMdd_HHmmss_fff')+'.txt');
  @('usantoosfps - DIAGNOSTICO LOCAL',('Windows: '+$os.Caption),('CPU: '+$cpu),('RAM utilizavel (GB): '+[math]::Round($os.TotalVisibleMemorySize/1MB,1)),'GPU e driver:',($gpu | Out-String),$plan) | Set-Content -LiteralPath $file -Encoding UTF8;
  Write-Host 'Relatorio salvo em' $file;`);

const guidPattern = '[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}';
const highPerformance = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const selectEnergy = powershell(`${backupDir}
  $plans=powercfg.exe /list; if($LASTEXITCODE -ne 0){throw 'Falha ao listar planos.'};
  if(($plans -join ' ') -notmatch '${highPerformance}'){throw 'Alto desempenho indisponivel neste equipamento. Mantenha o plano atual.'};
  $active=powercfg.exe /getactivescheme; if($LASTEXITCODE -ne 0 -or ($active -join ' ') -notmatch '${guidPattern}'){throw 'Falha ao consultar plano atual.'};
  $original=$matches[0]; $file=Join-Path $dir 'Plano_original.txt';
  if(!(Test-Path -LiteralPath $file)){
    $tmp=Join-Path $dir ([guid]::NewGuid().ToString()+'.tmp');
    try{[IO.File]::WriteAllText($tmp,$original); [IO.File]::Move($tmp,$file)}finally{if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}}
  };
  powercfg.exe /setactive '${highPerformance}'; if($LASTEXITCODE -ne 0){throw 'O Windows recusou a mudanca.'};`);
const restoreEnergy = powershell(`${backupDir}
  $file=Join-Path $dir 'Plano_original.txt';
  if(!(Test-Path -LiteralPath $file)){throw 'Nenhum plano original salvo para este usuario e PC.'};
  $id=([IO.File]::ReadAllText($file)).Trim(); if($id -notmatch '^${guidPattern}$'){throw 'Copia do plano invalida.'};
  powercfg.exe /setactive $id; if($LASTEXITCODE -ne 0){throw 'Plano removido ou bloqueado. Abra Opcoes de Energia e escolha um plano disponivel.'};`);

function tutorial(desktop) {
  return `usantoosfps | RAIO-X DO SEU SETUP
00 • COMECE AQUI
Windows 10 e 11 | Ordem sugerida para o primeiro uso

1. EXTRAIA ANTES DE COMEÇAR
No computador, abra Downloads. Clique com o botão direito no ZIP e escolha “Extrair Tudo…” > “Extrair”. Abra a pasta extraída. Se baixou no celular, transfira o ZIP para o PC e faça a extração nele. Abra este TXT com dois cliques. Se o Windows perguntar qual aplicativo usar, escolha Bloco de Notas.
Abra RESUMO_DO_SETUP.txt e confira os dados. Se errou o hardware, volte ao site, ajuste a seleção e baixe novamente.

2. ENTENDA O QUE ABRE NA TELA
TXT = texto para ler. BAT = painel de comandos: dê dois cliques, leia a mensagem e, quando aparecer “Pressione qualquer tecla”, aperte Enter para fechar. REG = ajuste importado pelo Editor do Registro. Todos os ajustes são opcionais. Faça um por vez para poder comparar.
Use a mesma conta do Windows para salvar, aplicar e restaurar os ajustes. Caso apareça um pedido de senha de OUTRA conta ao importar o REG, cancele e peça ajuda. Em PC de empresa, funções bloqueadas precisam do responsável pelo equipamento.

3. SALVE AS PREFERÊNCIAS • pasta 00_PREPARAR
a) Abra Abrir_Protecao_do_Sistema.bat. Na janela “Proteção do Sistema”, selecione o disco do Windows. Se a proteção estiver ativa, clique em “Criar”, digite “Antes do Raio-X”, confirme e aguarde a confirmação. Se estiver desativada, “Configurar” permite ativá-la se você for administrador. Feche a janela depois.
b) Ainda em 00_PREPARAR, dê dois cliques em Backup_dos_Visuais.bat. Aguarde “Backup disponivel”. O painel informa o caminho da cópia. Execute na sua conta habitual. Se houver falha, pare antes dos REG. Rodar de novo preserva a primeira cópia neste PC.

4. CONFIRA O COMPUTADOR • pasta 01_DIAGNOSTICO
Abra Relatorio_do_PC.bat com dois cliques. Aguarde o caminho do relatório no painel. Pressione Enter e abra o novo TXT que começa com Relatorio_ nesta mesma pasta. Confira Windows, CPU, RAM, GPU, driver e plano ativo. Se a pasta não permitir gravar, extraia o ZIP em Documentos e repita. Se a consulta de hardware estiver bloqueada, consulte o Gerenciador de Tarefas > Desempenho.

5. AJUSTES VISUAIS OPCIONAIS • pasta 02_REGEDITS
01_Reduzir_Transparencias.reg desliga transparências. 02_Ajustes_Visuais_Leves.reg reduz animações da barra de tarefas e define o atraso do menu em 100 ms. O efeito visível varia conforme a versão do Windows.
Depois do backup, escolha UM arquivo. Dê dois cliques; se aparecer “Executar”, confirme. No Controle de Conta de Usuário, confirme “Sim” somente para o Editor do Registro e a sua conta. Leia a pergunta sobre adicionar os dados e clique em “Sim”. Aguarde a mensagem de importação bem-sucedida e clique em “OK” (ou Enter quando OK estiver selecionado). Se abrir no Bloco de Notas, feche sem salvar e use botão direito > “Mostrar mais opções” se necessário > “Mesclar”. Se houver erro, pare. Saia e entre na sua sessão para conferir os efeitos.

6. FERRAMENTAS INDIVIDUAIS • pasta 03_FERRAMENTAS
• Abrir_Limpeza_de_Disco.bat: dois cliques. Selecione a unidade do Windows se solicitado. Leia cada categoria e marque apenas o que quer excluir; a Lixeira pode conter arquivos seus. Clique em OK > Excluir arquivos somente depois de revisar. Cancelar fecha sem limpar. Se o utilitário estiver ausente, abra Configurações > Sistema > Armazenamento > Arquivos temporários.
• Limpar_Cache_DNS.bat: use somente se precisar limpar o cache de nomes da rede. Clique com o botão direito no BAT > “Executar como administrador” > “Sim”. Aguarde a confirmação e pressione Enter. O cache volta a ser preenchido durante a navegação.
• Abrir_Configuracoes_Graficas.bat: dois cliques para abrir a página de gráficos. Escolha um jogo na lista, ou adicione o executável, abra “Opções” e revise a preferência de GPU antes de salvar. Em alguns PCs há apenas uma GPU. Para desfazer, volte à mesma tela e escolha a opção automática do Windows. Se a página não abrir, pesquise “Configurações de elementos gráficos” ou “Gráficos” no Iniciar.

7. ENERGIA • pasta 04_ENERGIA
${desktop ? 'Para testar no desktop, abra Ativar_Alto_Desempenho.bat. Pressione S para tentar ou N para cancelar. O painel verifica a disponibilidade do plano e guarda o plano atual antes da troca. Use a mesma conta para reverter. Se o plano estiver indisponível ou bloqueado, mantenha o plano atual. Consumo, temperatura e ruído podem aumentar. Não é preciso criar um plano novo.' : 'No notebook, abra Consultar_Plano.bat com dois cliques para ver o plano ativo. O painel apenas consulta. Para revisar as opções do fabricante, use Configurações > Sistema > Energia. Compare os resultados ligado à tomada e depois usando a bateria.'}

8. DESFAZER • pasta 99_RESTAURACAO
Para desfazer os REG, feche os aplicativos, abra Restaurar_Visuais.bat na mesma conta e no mesmo PC e pressione S para confirmar. O painel usa o backup original e remove os valores que antes não existiam. Encerre a sessão e entre novamente. ${desktop ? 'Para desfazer a troca de energia, abra Restaurar_Plano_Original.bat e confirme com S. Se o plano foi excluído depois, escolha um plano disponível pelo Painel de Controle > Opções de Energia.' : 'O painel de energia deste pack apenas consultou o plano. Não há alteração para reverter.'}
O backup fica em %LOCALAPPDATA%\\usantoosfps\\RaioX, dentro da subpasta com o nome do PC. Preserve-o. Sem backup, ajuste as preferências pelas Configurações do Windows ou consulte o ponto de restauração criado antes de começar.

9. SE UM PAINEL NÃO ABRIR OU INDICAR FALHA
Confirme que abriu a pasta extraída no Windows e que o nome termina em .bat ou .reg, não em .txt. Para conferir, no Explorador ative Exibir > Mostrar > Extensões de nomes de arquivos (Windows 10: guia Exibir). Se o Windows ou a política do PC bloquear a execução, pare e anote a mensagem. Não desative as proteções. Para suporte, use o atendimento em https://usantoosfps.com e envie o nome do arquivo e o texto exibido.
`;
}
const confirmAction = 'choice /c SN /n /m "Confirmar? [S/N] "\nif errorlevel 3 goto falha\nif errorlevel 2 exit /b 0\nif not errorlevel 1 exit /b 1\n';

export function buildTools(device) {
  const desktop = device === 'desktop';
  const files = {
    '00_COMECE_AQUI.txt': tutorial(desktop),
    '00_PREPARAR/Abrir_Protecao_do_Sistema.bat': panel('Protecao do Sistema','start "" "%SystemRoot%\\System32\\SystemPropertiesProtection.exe"','Confira a janela Protecao do Sistema.','Pesquise Criar ponto de restauracao no Iniciar.'),
    '00_PREPARAR/Backup_dos_Visuais.bat': panel('Salvar ajustes visuais',backupVisual,'Backup disponivel.','Backup nao confirmado. Pare antes de importar os REG.'),
    '01_DIAGNOSTICO/Relatorio_do_PC.bat': panel('Diagnostico local','set "RAIOX_DIR=%~dp0"\n'+report,'Diagnostico concluido.','Verifique a mensagem acima e a permissao de gravacao da pasta.'),
    '02_REGEDITS/01_Reduzir_Transparencias.reg': regFile(visualKeys.slice(0,1)),
    '02_REGEDITS/02_Ajustes_Visuais_Leves.reg': regFile(visualKeys.slice(1)),
    '03_FERRAMENTAS/Abrir_Limpeza_de_Disco.bat': panel('Limpeza de Disco','if not exist "%SystemRoot%\\System32\\cleanmgr.exe" goto falha\nstart "" "%SystemRoot%\\System32\\cleanmgr.exe"','Revise as categorias na janela aberta.','Use Configuracoes - Sistema - Armazenamento.'),
    '03_FERRAMENTAS/Limpar_Cache_DNS.bat': panel('Limpar cache DNS','ipconfig.exe /flushdns','Cache DNS limpo.','Tente com botao direito - Executar como administrador.'),
    '03_FERRAMENTAS/Abrir_Configuracoes_Graficas.bat': panel('Graficos do Windows','start "" ms-settings:display-advancedgraphics','Confira a janela Configuracoes.','Procure Graficos no menu Iniciar.'),
    '99_RESTAURACAO/Restaurar_Visuais.bat': panel('Restaurar preferencias visuais',confirmAction+restoreVisual,'Preferencias restauradas. Saia e entre na sessao.','Verifique a mensagem acima e use a mesma conta do backup.'),
  };
  if (desktop) {
    files['04_ENERGIA/Ativar_Alto_Desempenho.bat'] = panel('Alto desempenho opcional',confirmAction+selectEnergy,'Plano Alto desempenho ativado.','Mudanca nao confirmada. Consulte Opcoes de Energia.');
    files['99_RESTAURACAO/Restaurar_Plano_Original.bat'] = panel('Restaurar plano original',confirmAction+restoreEnergy,'Plano original restaurado.','Confira a mensagem acima.');
  } else {
    files['04_ENERGIA/Consultar_Plano.bat'] = panel('Plano ativo','powercfg.exe /getactivescheme','Consulta concluida.','Consulte Opcoes de Energia no Painel de Controle.');
  }
  return files;
}
