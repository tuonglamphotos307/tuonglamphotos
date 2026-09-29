# DriveDock

Phần mềm desktop để **tải xuống / tải lên Google Drive**, ý tưởng giống Air Explorer nhưng tập trung vào việc chuyển file nhanh và không phải trông chừng.

**Cách dùng nhanh nhất:** bấm **Tải từ link** (hoặc `Ctrl+L`, hoặc dán link ở bất kỳ đâu trong app), dán một hay nhiều link Google Drive, chọn thư mục lưu rồi bấm **Tải xuống**.

![Giao diện DriveDock](build/screenshot.png)

## Tính năng

- **Tải bằng link**: file, thư mục (tải cả cây thư mục con), link Docs/Sheets/Slides, link có `resourcekey`, dán nhiều link cùng lúc. Link được kiểm tra trước để anh thấy tên và dung lượng trước khi tải.
- **Không cần đăng nhập với file công khai**: file "Bất kỳ ai có link" tải được ngay, kể cả file lớn có cảnh báo "không quét được virus". Thư mục công khai cần đăng nhập hoặc một API key.
- **Hai khung, kéo thả**: bên trái là máy tính, bên phải là Google Drive (Drive của tôi, Được chia sẻ, Bộ nhớ dùng chung). Kéo từ khung này sang khung kia để tải lên / tải xuống, kéo thẳng vào một thư mục, hoặc kéo file từ Explorer vào khung Drive.
- **Hàng đợi bền bỉ**:
  - chạy song song nhiều file (1–8, chỉnh trong Cài đặt);
  - tạm dừng / tiếp tục / huỷ từng file hoặc tất cả;
  - **tải tiếp từ chỗ bị ngắt**: tải xuống dùng file tạm `.drivedock-part` và HTTP Range; tải lên dùng phiên resumable của Google, nên mất mạng hay tắt app đều không phải làm lại từ đầu;
  - tự thử lại khi mất mạng hoặc khi Google giới hạn tốc độ (backoff tăng dần);
  - hàng đợi được lưu lại, có tuỳ chọn *Tự tiếp tục khi mở app*.
- **Kiểm tra MD5** sau khi tải xuống, phát hiện được file hỏng.
- **Google Docs / Sheets / Slides** được xuất sang Office (hoặc PDF / OpenDocument), kể cả file lớn quá giới hạn của API export.
- **Xử lý trùng tên**: tự đổi tên (`ảnh (1).jpg`), bỏ qua, hoặc ghi đè (trên Drive thì tạo phiên bản mới, không tạo file trùng).
- Giữ nguyên ngày sửa của file, xử lý tên file có ký tự Windows không cho phép.
- Tìm kiếm không dấu trong thư mục ("tieu chi" khớp "TIÊU CHÍ"), sắp xếp theo tên / ngày / dung lượng, chọn nhiều file bằng Ctrl/Shift, menu chuột phải, phím tắt.
- Token đăng nhập được mã hoá bằng kho khoá của hệ điều hành (DPAPI trên Windows).

## Cài đặt và chạy

### Cách 1: tải file .exe đã build sẵn

Mỗi lần có code mới được push, GitHub Actions tự build bản Windows. Vào tab **Actions** của repo → chọn lần chạy mới nhất → tải artifact **DriveDock-windows** (gồm bản cài đặt và bản portable).

### Cách 2: chạy từ mã nguồn

Cần [Node.js 20+](https://nodejs.org).

```bash
npm install
npm start
```

Tự build file cài đặt: `npm run dist:win` (kết quả nằm trong thư mục `dist/`).

## Kết nối Google Drive (làm một lần)

DriveDock dùng OAuth Client của chính anh (miễn phí), nên hạn mức API là của riêng anh và không đi qua máy chủ trung gian nào.

1. Mở [Google Cloud Console](https://console.cloud.google.com/projectcreate) và tạo một project.
2. Bật [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
3. Vào [Google Auth Platform](https://console.cloud.google.com/auth/overview), chọn *External*, rồi thêm email của anh vào **Test users**.
   Khi app còn ở chế độ *Testing*, Google bắt đăng nhập lại sau 7 ngày. Bấm **Publish app** (không cần xác minh nếu chỉ anh dùng) để không bị như vậy.
4. Vào [Clients](https://console.cloud.google.com/auth/clients), bấm **Create client**, chọn loại **Desktop app**, rồi tải file JSON về.
5. Trong DriveDock: **Cài đặt**, bấm **Nhập từ credentials.json**, **Lưu**, rồi **Kết nối Google Drive**. Trình duyệt sẽ mở ra để anh đăng nhập.

Muốn tải thư mục công khai mà không đăng nhập thì tạo thêm một **API key** (Credentials → Create credentials → API key) và dán vào Cài đặt.

## Phím tắt

| Phím | Tác dụng |
| --- | --- |
| `Ctrl+L` / dán link | Mở hộp thoại Tải từ link |
| `Enter` / nhấp đúp | Mở thư mục / file |
| `Backspace` | Lên thư mục cha |
| `F5` | Làm mới |
| `F2` | Đổi tên |
| `Delete` | Xoá (vào Thùng rác / thùng rác Drive) |
| `Ctrl+A` | Chọn tất cả |
| Gõ chữ bất kỳ | Tìm trong thư mục |

## Cấu trúc mã nguồn

```
src/main/        tiến trình chính (Node)
  main.js        cửa sổ, IPC
  auth.js        OAuth 2.0 loopback + PKCE, lưu token mã hoá
  drive.js       client Drive REST v3: liệt kê, tải, export, resumable upload, retry
  transfers.js   logic tải xuống / tải lên từng file và thư mục
  queue.js       hàng đợi: song song, tạm dừng, thử lại, lưu trạng thái
  links.js       nhận diện mọi dạng link Google Drive
  local.js       duyệt ổ đĩa trên máy
src/preload.js   cầu nối an toàn giữa giao diện và tiến trình chính
src/renderer/    giao diện (HTML/CSS/JS thuần, không cần build)
test/            test (node --test)
```

Chạy test: `npm test`.
