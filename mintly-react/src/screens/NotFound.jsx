/**
 * 404 screen.
 * Member 7.
 */

import { useNavigate } from 'react-router-dom';
import { Button, Card, EmptyState } from '../components/ui/index.js';

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <Card>
      <EmptyState
        icon="🧭"
        title="That page does not exist"
        action={<Button size="lg" onClick={() => navigate('/')}>Back to the start</Button>}
      >
        The link may be out of date, or the address may have a typo in it.
      </EmptyState>
    </Card>
  );
}
