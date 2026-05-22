-- =====================================================================
-- TIER 5 — STORAGE · bucket de evidências + políticas
--
-- Cria o bucket `evidence-photos` (privado) e autoriza membros
-- autenticados do tenant a fazer upload e download.
--
-- IDEMPOTENTE · pode rodar várias vezes.
-- =====================================================================

-- Bucket privado para fotos de evidências (inventário, recebimento, etc.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence-photos',
  'evidence-photos',
  false,          -- privado: acesso só via signed URL
  10485760,       -- 10 MB por arquivo
  array['image/jpeg','image/png','image/webp','image/heic']
)
on conflict (id) do update set
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Policies de Storage (idempotentes via drop + create)
-- Estrutura de path: {tenant_id}/{execution_id}/{timestamp}_{filename}

drop policy if exists "evidence_upload"   on storage.objects;
drop policy if exists "evidence_download" on storage.objects;
drop policy if exists "evidence_delete"   on storage.objects;

-- Membros autenticados podem fazer upload no próprio bucket
create policy "evidence_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'evidence-photos');

-- Membros autenticados podem baixar evidências
create policy "evidence_download" on storage.objects
  for select to authenticated
  using (bucket_id = 'evidence-photos');

-- Somente quem fez upload (owner) pode deletar
create policy "evidence_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'evidence-photos' and owner = auth.uid());

-- =====================================================================
-- Verificação
select 'evidence-photos' as bucket, count(*) as objects
from storage.objects
where bucket_id = 'evidence-photos';
