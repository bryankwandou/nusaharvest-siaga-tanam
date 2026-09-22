-- Retention and erasure routine (UU PDP 27/2022).
--
-- nh_erase_enrollment_pii(enrollment) nulls every ciphertext column but keeps the
-- salted hashes (leaf, phone_lookup_hmac, proof_code) so the on-chain roster and the
-- public proof page stay verifiable after the personal data is gone. That is the point:
-- the chain never held personal data, so erasure costs nothing in auditability.

create or replace function nh_erase_enrollment_pii(p_enrollment uuid, p_reason text)
returns int
language plpgsql
as $$
declare
  n int;
begin
  update enrollments
     set phone_enc = '\x01'::bytea,
         payout_account_enc = null,
         payout_name_masked = null,
         lat_enc = null,
         lon_enc = null,
         pii_erased_at = now()
   where id = p_enrollment
     and pii_erased_at is null;
  get diagnostics n = row_count;
  if n > 0 then
    insert into pii_erasures (scope, subject_hmac, rows_erased, reason, erased_at)
    select 'subject_request', e.phone_lookup_hmac, n, p_reason, now()
      from enrollments e where e.id = p_enrollment;
  end if;
  return n;
end;
$$;

-- Scheduled sweep: every campaign that finished more than p_months ago.
create or replace function nh_run_retention(p_months int)
returns int
language plpgsql
as $$
declare
  c record;
  total int := 0;
  n int;
begin
  for c in
    select id from campaigns
     where status in ('receipted','refunded')
       and closed_at is not null
       and closed_at < now() - make_interval(months => p_months)
  loop
    update enrollments
       set phone_enc = '\x01'::bytea,
           payout_account_enc = null,
           payout_name_masked = null,
           lat_enc = null,
           lon_enc = null,
           pii_erased_at = now()
     where campaign_id = c.id
       and pii_erased_at is null;
    get diagnostics n = row_count;
    if n > 0 then
      insert into pii_erasures (scope, campaign_id, rows_erased, reason, erased_at)
      values ('retention', c.id, n, format('retention sweep, %s months after campaign close', p_months), now());
      total := total + n;
    end if;
  end loop;

  -- Conversation state and delivery receipts hold no ciphertext but do hold lookup
  -- hashes; drop the expired ones on the same sweep.
  delete from wa_sessions where expires_at < now();
  delete from rate_limits where window_start < now() - interval '1 day';
  return total;
end;
$$;
