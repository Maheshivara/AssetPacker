# Atlas Packer

A static web page that packs the textures of a GameMaker 1.4 game (`data.win` or `game.unx`) into the atlas files used by the Butterscotch GB300V2/SF2000 console port. It is a browser port of Synaps33 [FroggyTale](https://github.com/Synaps33/FroggyTale) `pack_assets.py` tool, and it produces the same file format.

Everything runs in your browser. The game file is never uploaded.

## Usage

1. Open `index.html` in a modern desktop browser, or host the folder on any static web server.
2. Choose your `data.win` or `game.unx` file, or drag it onto the page.
3. Pick a target resolution: 320 x 240, 640 x 480, or custom.
4. Click **Pack assets** and wait for the progress bar to finish.
5. Download `ATLAS.BIN` and `ATLAS.RGBA4444`.

## Output

- `ATLAS.BIN` - 32-byte header plus one 32-byte record per texture page item.
- `ATLAS.RGBA4444` - 2 bytes per pixel, one block per unique source rect.

## Target resolution

The longer side of the chosen resolution is used as the size cap. Source rects larger than the cap are box-filtered down to it. Smaller rects keep their full size. For example, 320 x 240 gives a cap of 320 px, which matches the script default (`--atlas-cap 320`).

### About Tradeoffs

> [!NOTE]
> All information bellow has been tested on a SF3000 running [FroggyTale](https://github.com/tzubertowski/TreeFrogUI_FroggyTale).

- The best performance is 320x240 (and some devices do not have screen resolution bigger than that), the 640x480 one runs well on SF3000 (without sounds), but will reduce your framerate.
- The 640x480 res improve the text legibility (biggest problem with the 320x240 version)

## Notes

- The whole game file is loaded into memory, so very large files need a browser with enough free RAM.
- Only GameMaker 1.4 files with PNG texture pages are supported.
- Colors in nearly transparent pixels can differ slightly from the Python output, because browser canvases pre-multiply alpha internally.

## Credits

- [Synaps33](https://github.com/Synaps33) for the [FroggyTale](https://github.com/Synaps33/FroggyTale) port
- [tzubertowski](https://github.com/tzubertowski) for the [TreeFrogUI](https://github.com/tzubertowski/TreeFrogUI) ecosystem
