REVOKE EXECUTE ON FUNCTION public.claim_attachments(uuid, integer) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.claim_attachments(uuid, integer) TO service_role;