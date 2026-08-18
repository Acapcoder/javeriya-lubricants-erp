/**
 * Renders a decimal money string.
 *
 * The value stays a string end to end — parsing it into a JS number to format
 * it would reintroduce exactly the precision loss the server works to avoid.
 * Grouping is applied to the integer part textually.
 */
export function Money({ value, className }: { value: string | null | undefined; className?: string }) {
  if (value === null || value === undefined || value === '') return <span className={className}>-</span>;

  const negative = value.startsWith('-');
  const [whole = '0', frac = '00'] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  return (
    <span className={className ? `money ${className}` : 'money'}>
      {negative ? '−' : ''}
      {grouped}.{frac.padEnd(2, '0').slice(0, 2)}
    </span>
  );
}
