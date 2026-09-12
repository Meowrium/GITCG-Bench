// Decode deck codes - run from assets-manager or root
import { staticDecode } from "../assets-manager/src/sharing";
import giTcgData from "../data/src/end";

const codes: Record<string, string> = {
  "4.101": "APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA",
  "4.102": "ApDg6RkOAqCw6ogPCECA9J0PCWDQ/cIPDNEgAsYQDKFgC8kQDLGQDtEQDeEQD9sQDvAA",
  "4.103": "AxBw9DUPAUCg9XMPCVBQ9rwPDIAg/cIPDNFgCsYQDKGQC8kQDbEQDdEQDeFwD90QD/AA",
  "4.104": "A3Bg9EsOAmDg6IgPCVFQ+MsPDJKA/tIPDOFQEuYQDLLQE+QQDeGQEuAQDtHgDt8QDvAA",
  "4.105": "AUGQ4XoPAlBQ8Y4PCVDg7HwPDMHA8sEPDKFRAs0QDJHREtIQDMHREuQQDeHRDuUQDeAA",
  "4.106": "A1AQ/HoPAmBw+JkPCYGQ/MgPDCHBEs0QDNKQEvIQDOHBEvQQDMHRE+QQDeEBFN0QDeAA",
  "4.107": "AyEg4H0PARGA+IkPCbCw984PDBGw9tAPDEGgEsoQDIHQE88QDKGwEuUQDZEQE98QDeAA",
  "4.108": "A2GgCXoPAaEQCIkPCVFQ/ssPDGHACc0QDLIBEtIQDMGQE+QQDMEwE+UQDeBQE8EQDeAA",
};

const { data } = giTcgData();

for (const [name, code] of Object.entries(codes)) {
  const deck = staticDecode(code);
  const chars = deck.characters.map((id: number) => {
    const def = data.entities.get(id);
    return def ? `${def.name}` : `Unknown(${id})`;
  });
  const cardIds = deck.cards.slice(0, 30);
  const cardNames = cardIds.map((id: number) => {
    const def = data.entities.get(id);
    return def ? def.name : `?(${id})`;
  });
  
  console.log(`\n=== ${name} ===`);
  console.log(`  角色: [${chars.join(", ")}]`);
  console.log(`  卡牌(${deck.cards.length}张): ${cardNames.slice(0, 15).join(", ")}`);
}
