# Saltline shared texture library — sources and licence

Every material in this folder comes from **ambientCG** (https://ambientcg.com), by Lennart Demes.

**Licence: Creative Commons CC0 1.0 Universal (public domain dedication)** — https://creativecommons.org/publicdomain/zero/1.0/
(ambientCG licence page: https://docs.ambientcg.com/license/). No attribution is required; it is recorded here anyway.

Each folder holds `albedo.ktx2` (sRGB, ETC1S/BasisLZ), `orm.ktx2` (R = ambient occlusion, G = roughness, B = metalness;
linear, ETC1S/BasisLZ) and `normal.ktx2` (OpenGL convention, linear, UASTC + zstd), all with full mip chains, plus the
same three as `*_512.ktx2` at half size for phones. Desktop size is 1024 px wide (512 for glass, brass, chrome); brick
and foliage are 2:1. `glass` has only `orm` (fingerprint / smudge roughness). Built on the VPS from the 1K-JPG downloads
with KTX-Software 4.4.2 `toktx` (`--encode etc1s --clevel 2 --qlevel 128 --genmipmap`; normals
`--encode uastc --uastc_quality 2 --zcmp 18 --genmipmap --normalize`). Tint materials (painted_steel, nonslip, fabric)
were converted to neutral grey (luminance, mean sRGB 0.878) so code can multiply a paint colour onto them.

| Material | ambientCG asset | Page | Download used |
|---|---|---|---|
| painted_steel | Paint004 | https://ambientcg.com/view?id=Paint004 | https://ambientcg.com/get?file=Paint004_1K-JPG.zip |
| rusted_steel | Rust009 | https://ambientcg.com/view?id=Rust009 | https://ambientcg.com/get?file=Rust009_1K-JPG.zip |
| galvanised | Metal037 | https://ambientcg.com/view?id=Metal037 | https://ambientcg.com/get?file=Metal037_1K-JPG.zip |
| nonslip | Rubber004 | https://ambientcg.com/view?id=Rubber004 | https://ambientcg.com/get?file=Rubber004_1K-JPG.zip |
| teak | Wood049 | https://ambientcg.com/view?id=Wood049 | https://ambientcg.com/get?file=Wood049_1K-JPG.zip |
| wood_planks | Planks023A | https://ambientcg.com/view?id=Planks023A | https://ambientcg.com/get?file=Planks023A_1K-JPG.zip |
| concrete | Concrete042A | https://ambientcg.com/view?id=Concrete042A | https://ambientcg.com/get?file=Concrete042A_1K-JPG.zip |
| asphalt | Asphalt025A | https://ambientcg.com/view?id=Asphalt025A | https://ambientcg.com/get?file=Asphalt025A_1K-JPG.zip |
| paving | PavingStones070 | https://ambientcg.com/view?id=PavingStones070 | https://ambientcg.com/get?file=PavingStones070_1K-JPG.zip |
| brick | Bricks085 | https://ambientcg.com/view?id=Bricks085 | https://ambientcg.com/get?file=Bricks085_1K-JPG.zip |
| plaster | Plaster001 | https://ambientcg.com/view?id=Plaster001 | https://ambientcg.com/get?file=Plaster001_1K-JPG.zip |
| corrugated | CorrugatedSteel005 | https://ambientcg.com/view?id=CorrugatedSteel005 | https://ambientcg.com/get?file=CorrugatedSteel005_1K-JPG.zip |
| roof_tiles | RoofingTiles006 | https://ambientcg.com/view?id=RoofingTiles006 | https://ambientcg.com/get?file=RoofingTiles006_1K-JPG.zip |
| glass | Fingerprints002 | https://ambientcg.com/view?id=Fingerprints002 | https://ambientcg.com/get?file=Fingerprints002_1K-JPG.zip |
| carpet | Carpet012 | https://ambientcg.com/view?id=Carpet012 | https://ambientcg.com/get?file=Carpet012_1K-JPG.zip |
| fabric | Fabric062 | https://ambientcg.com/view?id=Fabric062 | https://ambientcg.com/get?file=Fabric062_1K-JPG.zip |
| leather | Leather037 | https://ambientcg.com/view?id=Leather037 | https://ambientcg.com/get?file=Leather037_1K-JPG.zip |
| brass | Metal048A | https://ambientcg.com/view?id=Metal048A | https://ambientcg.com/get?file=Metal048A_1K-JPG.zip |
| chrome | Metal049A | https://ambientcg.com/view?id=Metal049A | https://ambientcg.com/get?file=Metal049A_1K-JPG.zip |
| foliage | LeafSet026 | https://ambientcg.com/view?id=LeafSet026 | https://ambientcg.com/get?file=LeafSet026_1K-JPG.zip |
| bark | Bark012 | https://ambientcg.com/view?id=Bark012 | https://ambientcg.com/get?file=Bark012_1K-JPG.zip |
| sand | Ground054 | https://ambientcg.com/view?id=Ground054 | https://ambientcg.com/get?file=Ground054_1K-JPG.zip |
| rock | Rock030 | https://ambientcg.com/view?id=Rock030 | https://ambientcg.com/get?file=Rock030_1K-JPG.zip |
| grass | Grass004 | https://ambientcg.com/view?id=Grass004 | https://ambientcg.com/get?file=Grass004_1K-JPG.zip |
