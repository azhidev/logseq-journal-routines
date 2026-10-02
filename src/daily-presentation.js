// Native query titles carry a presentation marker; never target unrelated user queries.
const queryChild = '> .block-children-container > .block-children > .ls-block:only-child > .block-main-container .custom-query';
const marked = `${queryChild} > .th [data-jr-query]`;
const empty = `${queryChild} > .bd > .custom-query-results > div.text-sm.mt-2.opacity-90:only-child`;

export const DAILY_PRESENTATION_STYLE = `
/* Retain extra user-authored children and query errors; only hide confirmed empty sections. */
.ls-block:has(${queryChild} > .th [data-jr-query="priority"], ${queryChild} > .th [data-jr-query="pending"]):has(${empty}) {
  display: none;
}
/* Remove the query-block wrapper indentation, not nesting inside actual tasks. */
.ls-block:has(${marked}) > .block-children-container {
  margin-left: 0 !important; padding-left: 0 !important;
}
.ls-block:has(${marked}) > .block-children-container > .block-children-left-border {
  display: none;
}
.ls-block:has(> .block-main-container .custom-query > .th [data-jr-query]) > .block-main-container > .block-control-wrap .bullet-container {
  visibility: hidden;
}
.custom-query:has(> .th [data-jr-query]) > .th {
  display: none;
}
.custom-query:has(> .th [data-jr-query]) > .bd {
  padding-top: 0;
}
`;
