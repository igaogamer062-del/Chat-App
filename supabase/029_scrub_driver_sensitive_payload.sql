-- Remove CPF dos payloads de diagnóstico. A validação usa apenas hash com pepper.
begin;

update public.external_driver_directory
set raw_payload =
  (coalesce(raw_payload,'{}'::jsonb) - 'cpf' - 'document' - 'document_number')
  #- '{driver,cpf}'
  #- '{driver,document}'
  #- '{condutor,cpf}'
where cpf_last4_hash is not null
  and (
    raw_payload ? 'cpf'
    or raw_payload ? 'document'
    or raw_payload ? 'document_number'
    or raw_payload #> '{driver,cpf}' is not null
    or raw_payload #> '{driver,document}' is not null
    or raw_payload #> '{condutor,cpf}' is not null
  );

commit;
