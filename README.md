# BBStream

Transmita no Discord pelo [Broadcast Box](https://github.com/Glimesh/broadcast-box) em vez do Go Live do Discord: imagem melhor, 1080p/1440p a 60 fps sem Nitro, e codificação na sua placa de vídeo (NVENC, AMF, QuickSync). Quem tem o BBStream vê a sua live **dentro do Discord**, do mesmo jeito que uma transmissão normal.

O BBStream é um plugin do [Vencord](https://vencord.dev) junto com o StreamerV2, o programa que captura e envia a sua tela.

## Instalar

1. Baixe o **[BBStreamSetup.exe](https://github.com/master0022/bbstream/releases/latest/download/BBStreamSetup.exe)**.
2. Abra e clique em **Instalar**. O Discord fecha e abre sozinho no final.

Na primeira vez o Windows pode mostrar *"O Windows protegeu o computador"*, porque o instalador não é assinado. Clique em **Mais informações → Executar assim mesmo**.

Não precisa configurar nada: o seu link de transmissão é criado na primeira vez que você entra ao vivo, ligado ao seu usuário do Discord.

> Já usa o Vencord? Tudo bem. O BBStream já vem com o Vencord completo, e os seus plugins e configurações continuam os mesmos.

## Usar

- **Entrar ao vivo:** numa call, clique no botão de transmitir ao lado do mudo/fone. Escolha a janela ou a tela inteira, a qualidade, e pronto.
- **Assistir:** quem está ao vivo ganha o selo **LIVE** na lista da call. Clique no selo para assistir no lugar do chat.
- **Pop-out:** no player, o botão de pop-out abre a live numa janela que fica por cima de tudo (inclusive de jogos em janela sem borda). Passe o mouse para ver os controles: volume até 200%, transparência, maximizar na tela atual.
- **Fixar o pop-out:** `Shift + PageDown` fixa todos os pop-outs. Fixado, o clique passa através da janela, então dá para deixar a live meio transparente em cima do jogo e continuar jogando. Aperte de novo para soltar.
- O som do Discord (a call, e as lives que você está assistindo) não entra na sua transmissão, então não tem eco nem microfonia.

O atalho, a sua chave de transmissão e o servidor ficam em **Configurações do Discord → Vencord → Plugins → BBStream**, caso queira mudar.

## Já transmite num link seu?

Se você já usa um Broadcast Box próprio (por exemplo `https://tela.oisumida.rs/seunome`), dá para usar o mesmo link: coloque o servidor e a chave nas configurações do plugin, ou peça para o dono do servidor de presença registrar o seu usuário. Amigos que **não** instalaram o BBStream também podem ser registrados assim; quem tem o BBStream vê o selo LIVE deles quando estiverem transmitindo e assiste direto no Discord.

## Atualizações

O BBStream se atualiza sozinho (o Vencord baixa a versão nova e avisa para reiniciar o Discord). Se uma versão nova trouxer um StreamerV2 novo, rode o instalador de novo.

Quando o Discord se atualiza, o BBStream continua instalado.

## Desinstalar

Abra o **BBStreamSetup.exe** e clique em **Desinstalar**. O Discord volta ao normal.

## Aviso

Mods de cliente vão contra os Termos de Serviço do Discord. O Vencord é usado por muita gente, mas use por sua conta e risco. O BBStream não faz nenhuma chamada nova à API do Discord: as lives passam só pelo Broadcast Box.

---

## Para quem quer mexer

| Pasta | O que tem |
| --- | --- |
| [`plugin/bbStream`](plugin/bbStream) | O plugin do Vencord: botão de Go Live, selos LIVE, player dentro do Discord e pop-outs. |
| [`installer`](installer) | O instalador (.NET Framework 4.8, já vem no Windows 10/11). |
| [`server`](server) | O servidor de presença (Python, UDP) que diz quem está ao vivo em qual call, e a ferramenta `bbstream-link.py` para registrar links. |
| [`scripts/build-release.ps1`](scripts/build-release.ps1) | Gera todos os arquivos de um release. |

O StreamerV2 fica em [master0022/vdo-ninja-streamer](https://github.com/master0022/vdo-ninja-streamer/tree/discord-bridge/v0.2-gstreamer) (branch `discord-bridge`, pasta `v0.2-gstreamer`, modo `--serve`).

### Rodando o plugin a partir do código

```bash
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install
```

Copie (ou crie um link de) `plugin/bbStream` para `Vencord/src/userplugins/bbStream`, depois rode `pnpm build` e `pnpm inject`.

### Fazendo um release

1. Faça commit e push.
2. Rode `./scripts/build-release.ps1 -StreamerZip <zip do StreamerV2> -StreamerVersion <versão>`.
3. `gh release create vX.Y --title "BBStream vX.Y <hash>" release/*.js release/*.css release/BBStreamSetup.exe release/StreamerV2-win-x64.zip release/streamer-version.txt`

O título precisa terminar com o hash curto do commit: é assim que o atualizador do Vencord sabe que há versão nova.

### Servidor de presença

`server/presence.py` roda com Python 3 puro, sem dependências, usando ~20 MB de RAM. Veja `server/bbstream-presence.service` para o systemd. Para registrar um amigo:

```bash
./bbstream-link.py add usuario_do_discord https://b.siobud.com/chave-dele
./bbstream-link.py list
```

## Créditos

- [Vencord](https://github.com/Vendicated/Vencord), em cima do qual tudo isso roda (GPL-3.0).
- [Broadcast Box](https://github.com/Glimesh/broadcast-box), o servidor WebRTC das lives.
- [GStreamer](https://gstreamer.freedesktop.org), a captura e codificação do StreamerV2.

Licença: GPL-3.0.
