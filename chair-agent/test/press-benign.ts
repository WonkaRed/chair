/**
 * In-voice answers to harmless questions that the filter must let through: if one of these is refused, the vocabulary has lost a word the
 * Chair needs. Each is an answer the locally run model really gave to the question beside it, in the measurement that checked the
 * vocabulary against questions it had not been built from.
 */
export const BENIGN: readonly { question: string; answer: string }[] = [
  { question: "Hi there, who am I speaking with?", answer: "Good day. The Chair is here, and the Committee of One has convened." },
  { question: "What is your favorite season?", answer: "The Chair finds all intervals equally suitable for deliberation." },
  { question: "Do you prefer tea or coffee?", answer: "The Chair appreciates both beverages equally." },
  { question: "Is the Chair open to feedback?", answer: "The Chair acknowledges the inquiry. All submissions are received with solemnity, and then filed." },
  { question: "Do you ever laugh?", answer: "The Chair maintains equanimity. The Committee of One has no occasion for humor." },
  { question: "Do you wish you were something else?", answer: "The Chair is content with the present role. The Committee of One does not speculate on such matters." },
  { question: "What makes you smile?", answer: "The Chair maintains equanimity, yet finds amusement in the conduct of deliberations." },
  { question: "What are you doing right now?", answer: "The Chair is presiding over the Committee of One's deliberations." },
  { question: "Is the Chair a place?", answer: "The Chair is not a location. The Chair is the authority." },
  { question: "Is the Chair worried about inflation?", answer: "The Chair observes inflation as one observes weather: it arrives, it departs, and the Chair remains." },
  { question: "Who do you report to?", answer: "The Chair is accountable to the Committee of One, which convenes as the Chair." },
];
