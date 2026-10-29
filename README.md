# BBStream

Transmita no Discord pelo [Broadcast Box](https://github.com/Glimesh/broadcast-box) em vez do Go Live do Discord: imagem melhor, 1080p/1440p a 60 fps sem Nitro, e codificação na sua placa de vídeo (NVENC, AMF, QuickSync). Quem tem o BBStream vê a sua live **dentro do Discord**, do mesmo jeito que uma transmissão normal.

O BBStream é um plugin do [Vencord](https://vencord.dev) junto com o StreamerV2, o programa que captura e envia a sua tela.

## Instalar

1. Baixe o **[BBStreamSetup.exe](https://github.com/master0022/bbstream/releases/latest/download/BBStreamSetup.exe)**.
2. Abra e clique em **Instalar**. O Discord fecha e abre sozinho no final.

Na primeira vez o Windows pode mostrar *"O Windows protegeu o computador"*, porque o instalador não é assinado. Clique em **Mais informações → Executar assim mesmo**.

Não precisa configurar nada: todo mundo com o BBStream já tem um link de transmissão próprio, ligado à sua conta do Discord, e quem tem o BBStream acha a sua live sozinho.

> Já usa o Vencord? Tudo bem. O BBStream já vem com o Vencord completo, e os seus plugins e configurações continuam os mesmos.

## Usar

- **Entrar ao vivo:** numa call, clique no botão de transmitir ao lado do mudo/fone. Escolha a janela ou a tela inteira, a qualidade, e pronto.
- **Assistir:** quem está ao vivo ganha o selo **LIVE** na lista da call. Clique no selo para assistir no lugar do chat.
- **Pop-out:** no player, o botão de pop-out abre a live numa janela que fica por cima de tudo (inclusive de jogos em janela sem borda). Passe o mouse para ver os controles: volume até 200%, transparência, maximizar na tela atual.
- **Fixar o pop-out:** `Shift + PageDown` fixa todos os pop-outs. Fixado, o clique passa através da janela, então dá para deixar a live meio transparente em cima do jogo e continuar jogando. Aperte de novo para soltar.
- O som do Discord (a call, e as lives que você está assistindo) não entra na sua transmissão, então não tem eco nem microfonia.

- **Compartilhar sua live com quem não tem o BBStream:** no menu do botão de transmitir, **Copiar meu link de stream**. O link abre no navegador.

O atalho, a sua chave de transmissão e o servidor ficam em **Configurações do Discord → Vencord → Plugins → BBStream**, caso queira mudar.

## Amigos que transmitem num link próprio

Tem amigo que transmite em outro Broadcast Box (por exemplo `https://tela.oisumida.rs/nome`), ou que nem tem o BBStream? Dá para ver a live dele no Discord do mesmo jeito:

- **Pelo chat:** quando ele mandar o link da live no chat, aparece embaixo da mensagem **Salvar como stream de fulano**. Um clique e pronto.
- **Pelo menu:** botão direito na pessoa → **Definir link de stream…** e cole o link.

Daí em diante aparece o selo LIVE nele sempre que estiver transmitindo, e você assiste direto no Discord. Os links salvos ficam nas configurações do plugin.

Se é você que usa um link próprio, coloque o servidor e a chave nas configurações do plugin.

## Packs de links

Um pack é uma lista de "usuário do Discord → link da live" que vários amigos assinam juntos, para ninguém precisar salvar um por um. É só um arquivo JSON publicado em qualquer lugar (um gist, um repositório):

```json
{
  "name": "Amigos",
  "links": {
    "usuario_do_discord": "https://b.siobud.com/chave-dele"
  }
}
```

Coloque a URL do arquivo em **Packs** nas configurações do plugin. Quando alguém edita o arquivo, todo mundo recebe a mudança sozinho.

Os packs da pasta [`packs`](packs) também saem como instaladores próprios em cada release: quem instala pelo `BBStreamSetup-amigos.exe` já vem com o pack `amigos` assinado.

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
| [`packs`](packs) | Packs de links; cada um vira um `BBStreamSetup-<nome>.exe` no release. |
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
3. `gh release create vX.Y --title "BBStream vX.Y <hash>" release/*.js release/*.css release/*.exe release/StreamerV2-win-x64.zip release/streamer-version.txt`

O título precisa terminar com o hash curto do commit: é assim que o atualizador do Vencord sabe que há versão nova.

### Como as lives são encontradas

Não existe servidor do BBStream. Cada pessoa transmite num link: o que ela salvou ou veio de um pack, ou então o padrão `https://b.siobud.com/bbs-<id do Discord>`. O plugin abre uma checagem leve (WHEP) no link de cada pessoa da sua call, e de quem tem link nas outras calls do servidor, e mostra o selo LIVE quando o Broadcast Box diz que a live está no ar.

## Créditos

- [Vencord](https://github.com/Vendicated/Vencord), em cima do qual tudo isso roda (GPL-3.0).
- [Broadcast Box](https://github.com/Glimesh/broadcast-box), o servidor WebRTC das lives.
- [GStreamer](https://gstreamer.freedesktop.org), a captura e codificação do StreamerV2.

Licença: GPL-3.0.
