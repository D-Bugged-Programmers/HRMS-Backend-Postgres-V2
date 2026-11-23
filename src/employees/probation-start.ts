// Purpose: whether a new hire starts on probation (status Probation, end date worked out from the joining date).
// Important: two ways, the same result - the "Start on probation" tick on the Add Employee form, or the older "Probation" category that
//   companies set up earlier still use.
export const startsOnProbation = (dto: { employeeType?: string; startOnProbation?: boolean }): boolean =>
  dto.startOnProbation === true || dto.employeeType === 'probation';
