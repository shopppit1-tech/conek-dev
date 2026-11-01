# YouTube Daily Upload

Workflow `.github/workflows/youtube-daily-upload.yml` berjalan setiap hari pukul **08.00 WIB** (`01:00 UTC`) dan dapat dijalankan manual dari tab **Actions**.

## GitHub Actions secrets

Tambahkan secrets berikut pada repository:

- `SUPABASE_URL`: URL project Supabase.
- `SUPABASE_SERVICE_ROLE_KEY`: service-role key Supabase. Simpan hanya di GitHub Actions secrets; jangan taruh di frontend.
- `YOUTUBE_CLIENT_ID`: OAuth Client ID Google.
- `YOUTUBE_CLIENT_SECRET`: OAuth Client Secret Google.
- `YOUTUBE_REFRESH_TOKEN`: refresh token OAuth dengan scope YouTube upload.

## Job yang di-upload

Script hanya mengambil job yang memenuhi semua kondisi berikut:

- `status = completed`
- `youtube_status = ready`
- `output_path` tidak kosong

Setelah upload berhasil, script mengisi `youtube_status = uploaded` dan `youtube_video_id`. Jika gagal, status diubah menjadi `failed` dan pesan disimpan pada kolom `error`.

## Menandai video siap upload

Setelah pipeline subtitle selesai, set field berikut pada `video_jobs`:

```sql
update public.video_jobs
set youtube_status = 'ready',
    youtube_privacy = 'private'
where id = '<job-uuid>';
```

Nilai `youtube_privacy` yang didukung adalah `private`, `unlisted`, dan `public`. Default yang aman adalah `private`.

## Menjalankan manual

Buka **GitHub → Actions → Upload Video YouTube Harian → Run workflow**. Input `videos_per_run` default-nya `1`, sesuai batas satu video per hari.
