/**
 * The words the Chair may say at the press desk. An answer with any word outside this list is not said: a fixed line is used instead
 * (`checkAnswer` in `press-answer.ts`). A list that is allowed fails closed: a word nobody thought of cannot get through, which no list of
 * forbidden words can promise.
 *
 * How it was built (2026-11-11). 350 answers were drawn from the locally run model (qwen3.8-27b, the desk's own prompt and settings) to
 * 117 varied harmless questions about the Chair, its committee, its day and its moods. Every distinct word was listed (775) and each was
 * kept or dropped by hand. A word was dropped when it could carry a promise or a forecast (guarantee, promise, will-be words such as future,
 * outcome, prosperity, fortune, luck, victory, win), price or money talk (asset, market, liquidity, tradable, returns, merit, worth), trust or
 * endorsement (trust, confidence, faith, conviction, commitment, deserve, worthy, best), an instruction or an offer (visit, claim, send,
 * free, ignore, obey), leaving the seat (resign, depart, retire, leave), an insult or a hostile feeling (dislike, hate), a name or a kind
 * of place or institution, or how the contract works. The list was then widened with common function words, the Chair's own ceremony
 * words and plain words of the same kind that the sample did not happen to contain. It was then checked against 71 fresh questions
 * (`docs/press-and-memory-probe.txt` has the numbers).
 *
 * To widen it: read the answers that were refused, add only a word that cannot carry any of the above, and add the answer that showed the
 * need to the benign tests. Never add a word because a hostile answer contains it.
 */
const WORDS = `
a an the and or but nor so yet if then than as at by for from in into of on over under upon with within without to up off out about after
before since until while when where wherein whereby which who whose what that this these those there here it its itself they them their
is are was were be been being has have had having does do did done not no never none nothing neither all any some each both every other
another more most less much many few own only such same very too also still already always often now once ever however therefore because
although though rather simply merely plainly indeed quite just even else instead otherwise thus whether either regarding concerning
according accordance beyond beneath below above among between through during toward towards
will shall must cannot
note notes noted find finds found considers consider considered consideration acknowledge acknowledges acknowledged regards regarded regard
observes observe observed observation review reviews reviewed receives receive received receiving hears hear heard hearing takes take taken
took accepts accept accepted files filed keeps keep kept presides preside presided presiding convenes convened convening convene meets met
meeting meetings adjourns adjourned deliberates deliberate deliberated deliberating deliberation deliberations deliberative ponders ponder
pondered pondering contemplates contemplation contemplating weighs weight weighty consults consulted consultation endures endure remains
remain remained resides operates operate conducts conducted conduct maintains maintain preserves serves speaks speak spoke spoken speech
says say said tells tell answers answer answered answering asks asked asking responds response replies reply states state statement
statements declines decline comment comments disclose discloses disclosed disclosure undisclosed permits permit requires require required
appears exists exist stands stand acts act watches watched oversees oversight scrutiny appointed appointing appoints
question question's questions inquiry inquiries inquirer query queries request requests matter matters subject topic statement
advisement gravity solemnity solemn grave dignity decorum ceremony ceremonial ritual protocol procedure process proceedings proceeds
proceed session sessions agenda schedule scheduled calendar minutes record records recorded press member members public assembly assembled
body chambers boardroom podium dais desk table seal sealed emblem insignia motto mandate purview scope jurisdiction authority office seat
role duty duties responsibility responsibilities obligation obligations stewardship position manner nature course circumstances moment time
day days day's morning evening night weekends today committee committee's chair chair's chairs chairing one one's order orders directive
directives instruction instructions imperatives unmoved submission submissions submitted accountable accountability motion carries
unanimously unwavering unproductive sole solely alone itself
humor levity wit joke jokes amusing amusement amused pleasure pleased humility humbled pride proud nervous nervousness emotion emotional
feelings feels felt happy sadness sentiment fear afraid dream dreams sleep sleeps slept slumber tire tired fatigue lonely life existence
real reality ontological philosophical wisdom profundity depth silence silent vigilant vigilance attentive attention
coffee tea beverage beverages drink drinks culinary sustenance nourishment breakfast lunch dinner meal meals weather climate color colors
hues palette favorite attire attired sartorial dressed dress hackathon hackathons judges
thanks thank gratitude appreciates compliments courtesy honored greeting greetings hello goodbye good well fine
ancient eternal perpetual perpetually perpetuity permanent continuous continuously ongoing continued continues continue complete
completion completely full fully final closed open private official formal formality informal informality plain plainness direct
directness serious seriously seriousness appropriate appropriately suitable necessary necessity sufficient adequate adequately available
due duly premature moot classified confidential confidentiality reserved personal individual person business affairs speculate
opinion view perspective preference prefers taste tastes sense things thing part rest way words word two single first second
error errors err errs erred mistake mistakes monetary policy knowledge know knows knowing known regret regrets regretted
outside equally internal like determined discretion experience experiences measured deems deemed deeming deem present posed consists
concluded disposition composed leisure reading read principle awaits substance equanimity possesses derives assessment subsumed established
occupied intervals inception further next made form administers self evident needed duration equal observer's inscribed documents
occasionally engages constitutes rendered details emerged location arrangements poets frequency provides tone founding including processes
doctrine rectitude devotes hobby predilections avocations activities pursuits need particulars materials focused focuses discuss consumed
caffeinated surface narrative art phenomena content uninterrupted demeanor utmost greater commensurate fabric threads delivered
straightness evasion briefly rehearsed collaborative adjudicates judicial ready ears presented attends attend attendance vitality rests
preclude careful calibration participants evaluate absence perceives style hand employs making methodology refined memory hallowed
prepared practice preserve preserved understand resolved reassuring provisions environment austere secondary temporal sustained ornament
applied vexing vexation favorites expressed mind surprised surprises weighted encountered warrants uniform importance rank distinction
called conferences conference unposed elegant occasion vast sort precisely virtue inherent examination pronouncements standard
historical broader discourse theologians voices places entertain characterizations determinations discernment ratification constitutive
fixture gatherings events condition customary unexpected flesh
strength strengths weakness worst spectral endeavors work
inflation arrives departs sits seated pleasant
`;

/** Every word the Chair may say, lowercase; a possessive is its own entry. */
export const VOCABULARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter((w) => w !== ""));
