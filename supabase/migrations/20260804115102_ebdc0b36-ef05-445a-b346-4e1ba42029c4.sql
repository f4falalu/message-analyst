DROP FUNCTION IF EXISTS public.claim_attachments(uuid, integer);

CREATE OR REPLACE FUNCTION public.claim_attachments(
  _import_id uuid,
  _limit integer,
  _min_bytes bigint DEFAULT NULL,
  _max_bytes bigint DEFAULT NULL
)
 RETURNS TABLE(id uuid, filename text, storage_path text, mime_type text, message_seq integer, size_bytes bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT a.id
    FROM public.attachments a
    WHERE a.import_id = _import_id
      AND a.ocr_status = 'pending'
      AND (_min_bytes IS NULL OR COALESCE(a.size_bytes, 0) >= _min_bytes)
      AND (_max_bytes IS NULL OR COALESCE(a.size_bytes, 0) < _max_bytes)
    ORDER BY a.filename
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(50, _limit))
  )
  UPDATE public.attachments a
  SET ocr_status = 'processing'
  FROM picked
  WHERE a.id = picked.id
  RETURNING a.id, a.filename, a.storage_path, a.mime_type, a.message_seq, a.size_bytes;
END;
$function$;