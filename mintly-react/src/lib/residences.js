/**
 * DUT residences, shared by Register (the picker) and Profile (the label).
 *
 * The value is what POST /auth/register stores in users.residence_area_code
 * (Phase 4, max 100 characters) and what GET /profile returns as `residence`.
 *
 * Phase 4: the group leader noted the list was incomplete. The DUT-owned
 * Durban residences use the names on DUT's Student Housing page
 * (dut.ac.za/support_services/student_housing/student-residence): Alpine
 * Road, Baltimore Flats, Berea Residence, Campbell Hall, Corlo Court, Hertine
 * Court, Stratford Hall, Student Village and Walsingham Hall. The Midlands
 * and leased/accredited names were supplied by the group and are grouped
 * separately so they are easy to check and extend.
 */
export const RESIDENCES = [
  { value: '', label: 'Select your residence…' },
  {
    label: 'DUT residences — Durban',
    options: [
      { value: 'alpine-road', label: 'Alpine Road (Overport)' },
      { value: 'baltimore-flats', label: 'Baltimore Flats (Beachfront)' },
      { value: 'berea', label: 'Berea Residence' },
      { value: 'campbell-hall', label: 'Campbell Hall (Glenwood)' },
      { value: 'corlo-court', label: 'Corlo Court (Berea)' },
      { value: 'hertine-court', label: 'Hertine Court (Albert Park)' },
      { value: 'stratford-hall', label: 'Stratford Hall' },
      { value: 'student-village', label: 'Student Village' },
      { value: 'walsingham-hall', label: 'Walsingham Hall' },
    ],
  },
  {
    label: 'Midlands — Indumiso & Pietermaritzburg',
    options: [
      { value: 'indumiso-1', label: 'Indumiso Residence 1' },
      { value: 'indumiso-2', label: 'Indumiso Residence 2' },
      { value: 'indumiso-3', label: 'Indumiso Residence 3' },
      { value: 'indumiso-4', label: 'Indumiso Residence 4' },
      { value: 'indumiso-5', label: 'Indumiso Residence 5' },
      { value: 'indumiso-6', label: 'Indumiso Residence 6' },
      { value: 'pebs', label: 'PEBS (Pietermaritzburg)' },
      { value: 'roseville', label: 'Roseville (Pietermaritzburg)' },
      { value: 'aloes', label: 'Aloes (Pietermaritzburg)' },
      { value: '02-jesmond', label: '02 Jesmond (Pietermaritzburg)' },
    ],
  },
  {
    label: 'Leased & accredited residences',
    options: [
      { value: 'winterton', label: 'Winterton (New Student Village)' },
      { value: 'lynnfield-chestnut', label: 'Lynnfield Estates: Chestnut' },
      { value: 'boombox', label: 'Boombox Residence' },
      { value: 'chorley', label: 'Chorley Residence' },
    ],
  },
  {
    label: 'Not in a residence',
    options: [
      { value: 'private', label: 'Private accommodation / digs' },
      { value: 'home', label: 'Living at home' },
      { value: 'other', label: 'Other residence (not listed)' },
    ],
  },
];

const LABELS = new Map(
  RESIDENCES.flatMap((r) => (r.options ? r.options : [r]))
    .filter((r) => r.value)
    .map((r) => [r.value, r.label]),
);

/** Readable name for a stored residence value; unknown values come back as-is. */
export function residenceLabel(value) {
  if (!value) return null;
  return LABELS.get(value) || value;
}
