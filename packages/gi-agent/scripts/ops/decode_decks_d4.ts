import { DEFAULT_ASSETS_MANAGER } from "../../../assets-manager/src/index"
const d0 = DEFAULT_ASSETS_MANAGER.decode("ASBg2xwOATAw408OBEDw5JAPCRAA9JcPCUBw9aoPClCg9rwPC2HAC8kQDLGQEdIRDTAA")
const d1 = DEFAULT_ASSETS_MANAGER.decode("APBw4CAOAABA8Y4PCBDg9JcPCUBw9b0PDFAg9sIPDIGQCskQDKHQC80QDbHQDt8QDeAA")
console.log("deck0 chars:", d0.characters)
console.log("deck0 cards (first 8):", d0.cards.slice(0, 8))
console.log("deck1 chars:", d1.characters)
console.log("deck1 cards (first 8):", d1.cards.slice(0, 8))
